#define _GNU_SOURCE
#include <errno.h>
#include <linux/if_addr.h>
#include <linux/if_link.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/utsname.h>
#include <time.h>
#include <unistd.h>

/* Private mechanism fixture. All buffers are finite; no privileges or writes are needed. */
#define DUMP_BYTES (512U * 1024U)
#define PACKET_BYTES (64U * 1024U)
#define RECORDS 8192U
#define SIGNATURE_BYTES (64U * 1024U)
#define ATTEMPTS 32U

struct dump { unsigned char *bytes; size_t length; unsigned int records; int interrupted; };

static void fail(const char *message) {
  fprintf(stderr, "VM network observation failed: %s (%d)\n", message, errno);
  exit(1);
}

static struct dump read_dump(int fd, uint32_t port, uint32_t sequence, uint16_t type, size_t payload) {
  struct { struct nlmsghdr header; unsigned char data[sizeof(struct ifinfomsg)]; } request;
  memset(&request, 0, sizeof(request));
  request.header.nlmsg_len = (uint32_t) (NLMSG_HDRLEN + payload);
  request.header.nlmsg_type = type;
  request.header.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP;
  request.header.nlmsg_seq = sequence;
  request.header.nlmsg_pid = port;
  request.data[0] = AF_UNSPEC;
  struct sockaddr_nl kernel = { .nl_family = AF_NETLINK };
  if (sendto(fd, &request, request.header.nlmsg_len, 0, (struct sockaddr *) &kernel, sizeof(kernel)) != (ssize_t) request.header.nlmsg_len) fail("send dump");
  struct dump result = { .bytes = malloc(DUMP_BYTES), .length = 0, .records = 0, .interrupted = 0 };
  if (!result.bytes) fail("allocate dump");
  unsigned char packet[PACKET_BYTES];
  for (;;) {
    struct sockaddr_nl sender;
    struct iovec vector = { .iov_base = packet, .iov_len = sizeof(packet) };
    struct msghdr message = { .msg_name = &sender, .msg_namelen = sizeof(sender), .msg_iov = &vector, .msg_iovlen = 1 };
    ssize_t received = recvmsg(fd, &message, 0);
    if (received <= 0 || (message.msg_flags & MSG_TRUNC) || message.msg_namelen != sizeof(sender) || sender.nl_pid != 0) fail("incomplete kernel packet");
    size_t offset = 0;
    while (offset < (size_t) received) {
      if ((size_t) received - offset < sizeof(struct nlmsghdr)) fail("short header");
      struct nlmsghdr header;
      memcpy(&header, packet + offset, sizeof(header));
      if (header.nlmsg_len < sizeof(header) || header.nlmsg_len > (size_t) received - offset || header.nlmsg_seq != sequence || header.nlmsg_pid != port) fail("invalid dump");
      if (header.nlmsg_flags & NLM_F_DUMP_INTR) result.interrupted = 1;
      size_t length = NLMSG_ALIGN(header.nlmsg_len);
      if (length > (size_t) received - offset) fail("short alignment");
      if (header.nlmsg_type == NLMSG_ERROR || header.nlmsg_type == NLMSG_OVERRUN) fail("kernel rejected dump");
      if (header.nlmsg_type == NLMSG_DONE) {
        if (header.nlmsg_len != NLMSG_HDRLEN + sizeof(int)) fail("unknown completion shape");
        int status;
        memcpy(&status, packet + offset + NLMSG_HDRLEN, sizeof(status));
        if (status != 0 || offset + length != (size_t) received) fail("failed completion");
        return result;
      }
      if (header.nlmsg_type != (uint16_t) (type - 2U) || !(header.nlmsg_flags & NLM_F_MULTI) || ++result.records > RECORDS || result.length + length > DUMP_BYTES) fail("unknown or excessive records");
      memcpy(result.bytes + result.length, packet + offset, length);
      result.length += length;
      offset += length;
    }
  }
}

/* Link facts that decide which addresses and routes may exist; statistics move with traffic and are excluded. */
static size_t link_signature(const struct dump *links, unsigned char *out) {
  size_t used = 0;
  for (size_t offset = 0; offset < links->length;) {
    struct nlmsghdr header;
    memcpy(&header, links->bytes + offset, sizeof(header));
    if (header.nlmsg_len < NLMSG_HDRLEN + sizeof(struct ifinfomsg)) fail("short link record");
    struct ifinfomsg info;
    memcpy(&info, links->bytes + offset + NLMSG_HDRLEN, sizeof(info));
    if (used + sizeof(info.ifi_index) + sizeof(info.ifi_flags) > SIGNATURE_BYTES) fail("link signature bound");
    memcpy(out + used, &info.ifi_index, sizeof(info.ifi_index)); used += sizeof(info.ifi_index);
    memcpy(out + used, &info.ifi_flags, sizeof(info.ifi_flags)); used += sizeof(info.ifi_flags);
    size_t end = offset + header.nlmsg_len;
    for (size_t attribute = offset + NLMSG_HDRLEN + NLMSG_ALIGN(sizeof(info)); attribute + 4U <= end;) {
      uint16_t length, type;
      memcpy(&length, links->bytes + attribute, sizeof(length));
      memcpy(&type, links->bytes + attribute + 2U, sizeof(type));
      if (length < 4U || attribute + length > end) fail("invalid link attribute");
      type = (uint16_t) (type & NLA_TYPE_MASK);
      if (type == IFLA_IFNAME || type == IFLA_MASTER || type == IFLA_LINK || type == IFLA_LINK_NETNSID
          || type == IFLA_OPERSTATE || type == IFLA_CARRIER) {
        if (used + sizeof(type) + length > SIGNATURE_BYTES) fail("link signature bound");
        memcpy(out + used, &type, sizeof(type)); memcpy(out + used + sizeof(type), links->bytes + attribute, length);
        used += sizeof(type) + length;
      }
      attribute += (size_t) NLA_ALIGN(length);
    }
    offset += NLMSG_ALIGN(header.nlmsg_len);
  }
  return used;
}

static int link_present(const struct dump *links, int index) {
  for (size_t offset = 0; offset < links->length;) {
    struct nlmsghdr header;
    memcpy(&header, links->bytes + offset, sizeof(header));
    struct ifinfomsg info;
    memcpy(&info, links->bytes + offset + NLMSG_HDRLEN, sizeof(info));
    if (info.ifi_index == index) return 1;
    offset += NLMSG_ALIGN(header.nlmsg_len);
  }
  return 0;
}

/* Equal link signatures do not cover a link created and deleted between the two link dumps, nor a deleted link whose
   addresses and routes are not yet flushed; either can leave addresses or routes naming a link neither dump lists. */
static int references_present(const struct dump *links, const struct dump *addresses, const struct dump *routes) {
  for (size_t offset = 0; offset < addresses->length;) {
    struct nlmsghdr header;
    memcpy(&header, addresses->bytes + offset, sizeof(header));
    if (header.nlmsg_len < NLMSG_HDRLEN + sizeof(struct ifaddrmsg)) fail("short address record");
    struct ifaddrmsg address;
    memcpy(&address, addresses->bytes + offset + NLMSG_HDRLEN, sizeof(address));
    if (!link_present(links, (int) address.ifa_index)) return 0;
    offset += NLMSG_ALIGN(header.nlmsg_len);
  }
  for (size_t offset = 0; offset < routes->length;) {
    struct nlmsghdr header;
    memcpy(&header, routes->bytes + offset, sizeof(header));
    if (header.nlmsg_len < NLMSG_HDRLEN + sizeof(struct rtmsg)) fail("short route record");
    size_t end = offset + header.nlmsg_len;
    for (size_t attribute = offset + NLMSG_HDRLEN + NLMSG_ALIGN(sizeof(struct rtmsg)); attribute + 4U <= end;) {
      uint16_t length, type;
      memcpy(&length, routes->bytes + attribute, sizeof(length));
      memcpy(&type, routes->bytes + attribute + 2U, sizeof(type));
      if (length < 4U || attribute + length > end) fail("invalid route attribute");
      type = (uint16_t) (type & NLA_TYPE_MASK);
      if (type == RTA_OIF) {
        int index;
        if (length != 4U + sizeof(index)) fail("invalid route interface");
        memcpy(&index, routes->bytes + attribute + 4U, sizeof(index));
        if (!link_present(links, index)) return 0;
      } else if (type == RTA_MULTIPATH) {
        for (size_t hop = attribute + 4U; hop + sizeof(struct rtnexthop) <= attribute + length;) {
          struct rtnexthop next;
          memcpy(&next, routes->bytes + hop, sizeof(next));
          if (next.rtnh_len < sizeof(next) || hop + next.rtnh_len > attribute + length) fail("invalid next hop");
          if (!link_present(links, next.rtnh_ifindex)) return 0;
          hop += (size_t) RTNH_ALIGN(next.rtnh_len);
        }
      }
      attribute += (size_t) NLA_ALIGN(length);
    }
    offset += NLMSG_ALIGN(header.nlmsg_len);
  }
  return 1;
}

static void hex(const struct dump *value) {
  static const char digits[] = "0123456789abcdef";
  for (size_t i = 0; i < value->length; i++) {
    putchar(digits[value->bytes[i] >> 4U]);
    putchar(digits[value->bytes[i] & 15U]);
  }
}

int main(int argc, char **argv) {
  (void) argv;
  if (argc != 1) fail("no arguments accepted");
  uint16_t endian = 1;
  if (*(unsigned char *) &endian != 1 || sizeof(struct nlmsghdr) != 16 || sizeof(struct rtmsg) != 12 || sizeof(struct ifaddrmsg) != 8 || sizeof(struct ifinfomsg) != 16) fail("unsupported ABI");
  int fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE);
  if (fd < 0) fail("netlink socket");
  struct timeval timeout = { .tv_sec = 5, .tv_usec = 0 };
  if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) != 0) fail("receive deadline");
  struct sockaddr_nl local = { .nl_family = AF_NETLINK };
  if (bind(fd, (struct sockaddr *) &local, sizeof(local)) != 0) fail("bind observation socket");
  socklen_t size = sizeof(local);
  if (getsockname(fd, (struct sockaddr *) &local, &size) != 0 || size != sizeof(local)) fail("socket identity");
  /* Three dumps are not one kernel snapshot: a veth created or deleted between them leaves addresses or routes without
     their link. A census is emitted only when its link facts are unchanged around its address and route dumps and every
     address and route names one of its links. */
  static unsigned char before[SIGNATURE_BYTES], after[SIGNATURE_BYTES];
  struct dump links, addresses, routes;
  uint32_t sequence = 1;
  int dangling = 0;
  for (unsigned int attempt = 0;; attempt++) {
    if (attempt == ATTEMPTS) fail(dangling ? "address or route named an unlisted link in the last of its bounded observation attempts"
      : "link census changed during the last of its bounded observation attempts");
    if (attempt) {
      struct timespec pause = { .tv_sec = 0, .tv_nsec = 1000000L };
      if (nanosleep(&pause, NULL) != 0) fail("retry pause");
    }
    links = read_dump(fd, local.nl_pid, sequence++, RTM_GETLINK, sizeof(struct ifinfomsg));
    addresses = read_dump(fd, local.nl_pid, sequence++, RTM_GETADDR, sizeof(struct ifaddrmsg));
    routes = read_dump(fd, local.nl_pid, sequence++, RTM_GETROUTE, sizeof(struct rtmsg));
    struct dump check = read_dump(fd, local.nl_pid, sequence++, RTM_GETLINK, sizeof(struct ifinfomsg));
    size_t length = link_signature(&links, before);
    int stable = !links.interrupted && !addresses.interrupted && !routes.interrupted && !check.interrupted
      && link_signature(&check, after) == length && memcmp(before, after, length) == 0;
    dangling = stable && !references_present(&links, &addresses, &routes);
    free(check.bytes);
    if (stable && !dangling) break;
    free(links.bytes); free(addresses.bytes); free(routes.bytes);
  }
  if (close(fd) != 0) fail("close observation socket");
  char network[64];
  ssize_t network_length = readlink("/proc/self/ns/net", network, sizeof(network) - 1);
  if (network_length <= 0 || (size_t) network_length >= sizeof(network) - 1) fail("network namespace identity");
  network[network_length] = '\0';
  for (ssize_t i = 0; i < network_length; i++) if (!strchr("net:[]0123456789", network[i])) fail("network namespace representation");
  struct utsname system;
  if (uname(&system) != 0) fail("kernel identity");
  for (size_t i = 0; system.release[i]; i++) if (!strchr("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ._+-", system.release[i])) fail("kernel representation");
  if (strcmp(system.machine, "aarch64") != 0 && strcmp(system.machine, "x86_64") != 0) fail("unsupported architecture");
  printf("{\"format\":\"agenai.desktop-vm-network.v1\",\"byteOrder\":\"little\",\"kernel\":\"%s\",\"architecture\":\"%s\",\"networkNamespace\":\"%s\",\"links\":\"", system.release, system.machine, network);
  hex(&links); printf("\",\"addresses\":\""); hex(&addresses); printf("\",\"routes\":\""); hex(&routes);
  printf("\",\"complete\":true}\n");
  free(links.bytes); free(addresses.bytes); free(routes.bytes);
  return ferror(stdout) ? 1 : 0;
}
