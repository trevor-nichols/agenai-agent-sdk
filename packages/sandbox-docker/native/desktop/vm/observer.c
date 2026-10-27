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
#include <unistd.h>

/* Private mechanism fixture. All buffers are finite; no privileges or writes are needed. */
#define DUMP_BYTES (512U * 1024U)
#define PACKET_BYTES (64U * 1024U)
#define RECORDS 8192U

struct dump { unsigned char *bytes; size_t length; unsigned int records; };

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
  struct dump result = { .bytes = malloc(DUMP_BYTES), .length = 0, .records = 0 };
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
      if (header.nlmsg_len < sizeof(header) || header.nlmsg_len > (size_t) received - offset || header.nlmsg_seq != sequence || header.nlmsg_pid != port || (header.nlmsg_flags & NLM_F_DUMP_INTR)) fail("invalid or interrupted dump");
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
  struct dump links = read_dump(fd, local.nl_pid, 1, RTM_GETLINK, sizeof(struct ifinfomsg));
  struct dump addresses = read_dump(fd, local.nl_pid, 2, RTM_GETADDR, sizeof(struct ifaddrmsg));
  struct dump routes = read_dump(fd, local.nl_pid, 3, RTM_GETROUTE, sizeof(struct rtmsg));
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
