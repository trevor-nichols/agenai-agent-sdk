// Bounded nonblocking stdio and a controller lease; no guest-visible control endpoint exists.
#define _GNU_SOURCE
#include "protocol.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <time.h>
#include <unistd.h>

volatile sig_atomic_t stopping;
static int lease_ms;
static int64_t last_control;
static bool failed;

static int64_t milliseconds(void) {
  struct timespec time;
  if (clock_gettime(CLOCK_MONOTONIC, &time)) return -1;
  return (int64_t)time.tv_sec * 1000 + time.tv_nsec / 1000000;
}

int transport_initialize(int lease) {
  lease_ms = lease;
  last_control = milliseconds();
  int input = fcntl(STDIN_FILENO, F_GETFL), output = fcntl(STDOUT_FILENO, F_GETFL);
  if (last_control < 0 || input < 0 || output < 0 || fcntl(STDIN_FILENO, F_SETFL, input | O_NONBLOCK)
    || fcntl(STDOUT_FILENO, F_SETFL, output | O_NONBLOCK)) return -1;
  return 0;
}

void transport_renew(void) { last_control = milliseconds(); }
bool transport_failed(void) { return failed; }

static int transfer(void *bytes, size_t size, bool output) {
  size_t offset = 0;
  while (offset < size && !stopping) {
    int64_t now = milliseconds();
    int64_t remaining = lease_ms - (now - last_control);
    if (now < 0 || remaining <= 0) { errno = ETIMEDOUT; break; }
    struct pollfd fds[2] = {
      { .fd = STDIN_FILENO, .events = output ? 0 : POLLIN },
      { .fd = STDOUT_FILENO, .events = output ? POLLOUT : 0 }
    };
    int ready = poll(fds, 2, (int)remaining);
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0) { if (!ready) errno = ETIMEDOUT; break; }
    if ((fds[0].revents & (POLLERR | POLLNVAL)) || (fds[1].revents & (POLLERR | POLLHUP | POLLNVAL))) { errno = EPIPE; break; }
    if (output && (fds[0].revents & POLLHUP)) { errno = EPIPE; break; }
    int fd = output ? STDOUT_FILENO : STDIN_FILENO;
    if (!(fds[output ? 1 : 0].revents & (output ? POLLOUT : (POLLIN | POLLHUP)))) continue;
    ssize_t count = output ? write(fd, (char *)bytes + offset, size - offset) : read(fd, (char *)bytes + offset, size - offset);
    if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (count <= 0) { if (!count) errno = EPIPE; break; }
    offset += (size_t)count;
  }
  if (offset == size) return 0;
  failed = true;
  stopping = 1;
  return -1;
}

int transport_read(void *bytes, size_t size) { return transfer(bytes, size, false); }
int transport_frame(uint32_t kind, const void *bytes, size_t size) {
  if (size > CHUNK_BYTES) { errno = E2BIG; failed = true; stopping = 1; return -1; }
  uint32_t header[2] = { htonl(kind), htonl((uint32_t)size) };
  return transfer(header, sizeof(header), true) || transfer((void *)bytes, size, true);
}

void terminal(const char *status, const char *effect, int error, uint64_t count, int mode, const char *metadata) {
  char json[METADATA_BYTES], permissions[16];
  if (mode < 0) snprintf(permissions, sizeof(permissions), "null");
  else snprintf(permissions, sizeof(permissions), "%d", mode);
  int length = snprintf(json, sizeof(json),
    "{\"status\":\"%s\",\"effect\":\"%s\",\"errno\":%d,\"count\":\"%llu\",\"mode\":%s,\"entry\":%s}",
    status, effect, error, (unsigned long long)count, permissions, metadata ? metadata : "null");
  if (length < 0 || (size_t)length >= sizeof(json)) { failed = true; stopping = 1; return; }
  (void)transport_frame(REPLY_TERMINAL, json, (size_t)length);
}
