// Trusted Linux filesystem dispatcher. Only the controller owns the Engine-attached stdio channel.
#define _GNU_SOURCE
#include "filesystem.h"
#include <arpa/inet.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void stop_signal(int signal_number) { (void)signal_number; stopping = 1; }

int main(int argc, char **argv) {
  if (argc != 4 || strcmp(argv[1], "/store") || (strcmp(argv[2], "read") && strcmp(argv[2], "read_write"))) return 64;
  char *end;
  errno = 0;
  long lease = strtol(argv[3], &end, 10);
  if (errno || !argv[3][0] || *end || lease < 1 || lease > INT_MAX) return 64;
  struct sigaction action = { .sa_handler = stop_signal };
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  signal(SIGPIPE, SIG_IGN);
  if (transport_initialize((int)lease)) return 70;
  struct filesystem fs;
  if (filesystem_open(&fs, !strcmp(argv[2], "read_write"))) return 71;
  char ready[256];
  int length = snprintf(ready, sizeof(ready), "{\"protocol\":\"%s\",\"layout\":\"%s\",\"uid\":%u,\"gid\":%u}",
    FILESYSTEM_PROTOCOL, FILESYSTEM_LAYOUT, (unsigned)geteuid(), (unsigned)getegid());
  if (transport_frame(REPLY_READY, ready, (size_t)length)) stopping = 1;
  unsigned char bytes[CHUNK_BYTES];
  bool closed = false;
  while (!stopping) {
    uint32_t header[4];
    if (transport_read(header, sizeof(header))) break;
    unsigned op = ntohl(header[0]), flags = ntohl(header[1]);
    size_t path_size = ntohl(header[2]), data_size = ntohl(header[3]);
    if (path_size > PATH_BYTES || data_size > CHUNK_BYTES) { terminal("rejected", "none", E2BIG, 0, -1, NULL); break; }
    char path[PATH_BYTES + 1];
    if (transport_read(path, path_size) || transport_read(bytes, data_size)) break;
    path[path_size] = '\0';
    transport_renew();
    bool path_operation = op == OP_STAT || op == OP_READ || op == OP_LIST || op == OP_WRITE;
    bool valid = op >= OP_STAT && op <= OP_HEARTBEAT
      && (path_operation ? valid_path(path, path_size, op == OP_STAT || op == OP_LIST) : !path_size)
      && (op == OP_APPEND ? data_size > 0 : !data_size)
      && (op == OP_WRITE ? flags == 1 || flags == 2 : !flags);
    if (!valid) { terminal("rejected", fs.staged[0] ? "staged" : "none", EINVAL, fs.count, -1, NULL); continue; }
    if (op == OP_HEARTBEAT) { (void)transport_frame(REPLY_HEARTBEAT, NULL, 0); continue; }
    if (op == OP_CANCEL || op == OP_CLOSE) {
      filesystem_cancel(&fs, op == OP_CLOSE);
      if (op == OP_CLOSE && !fs.staged[0]) { closed = true; break; }
      continue;
    }
    if (path_operation && fs.activity != ACTIVITY_IDLE) { terminal("rejected", fs.staged[0] ? "staged" : "none", EBUSY, fs.count, -1, NULL); continue; }
    switch (op) {
      case OP_STAT: filesystem_stat(&fs, path); break;
      case OP_READ: filesystem_read(&fs, path); break;
      case OP_LIST: filesystem_list(&fs, path); break;
      case OP_NEXT: filesystem_next(&fs); break;
      case OP_WRITE: filesystem_write(&fs, path, flags); break;
      case OP_APPEND: filesystem_append(&fs, bytes, data_size); break;
      case OP_COMMIT: filesystem_commit(&fs); break;
      default: break;
    }
  }
  int cleanup_error = filesystem_cleanup(&fs);
  close(fs.stage);
  close(fs.root);
  close(fs.store);
  return cleanup_error ? 75 : closed && !transport_failed() ? 0 : 74;
}
