/* G05 Darwin research: one stable lock, one bounded published state, one bounded temp. */
#include <CommonCrypto/CommonDigest.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef SNAPSHOT_RESEARCH_ROOT
#error "Explicit preparation must fix a private research root."
#endif

#define MAX_STATE (1024 * 1024)
static const char magic[] = "AGENAI-SNAPSHOT-1\n";
#define HEADER_SIZE ((sizeof(magic) - 1) + 65 + 65)
static int root_fd, lock_fd, state_fd, temp_fd = -1, phase = 0, cleanup_mode;
static struct stat root_identity, lock_identity, state_identity;
static char key[65], lock_name[96], state_name[96], temp_name[96];

static void fail(const char *reason) {
  printf("{\"kind\":\"failure\",\"reason\":\"%s\",\"errno\":%d}\n", reason, errno);
  fflush(stdout);
  exit(1);
}
static int same(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}
static int private_file(const struct stat *value) {
  return S_ISREG(value->st_mode) && value->st_uid == getuid() && (value->st_mode & 0777) == 0600 && value->st_nlink == 1;
}
static int open_root(void) {
  char path[PATH_MAX], *rest;
  if (strlen(SNAPSHOT_RESEARCH_ROOT) >= sizeof(path) || SNAPSHOT_RESEARCH_ROOT[0] != '/') { errno = EINVAL; fail("root_path"); }
  strcpy(path, SNAPSHOT_RESEARCH_ROOT);
  int current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (current < 0) fail("root_open");
  for (char *part = strtok_r(path, "/", &rest); part; part = strtok_r(NULL, "/", &rest)) {
    int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) fail("root_component");
    close(current); current = next;
  }
  return current;
}
static void assert_paths(void) {
  struct stat root, lock, state;
  int current = open_root();
  if (fstat(current, &root) < 0) fail("root_stat");
  close(current);
  if (!same(&root_identity, &root) || root.st_uid != getuid() || (root.st_mode & 0777) != 0700) { errno = ESTALE; fail("root_replaced"); }
  if (fstatat(root_fd, lock_name, &lock, AT_SYMLINK_NOFOLLOW) < 0
      || !same(&lock_identity, &lock) || !private_file(&lock)) { errno = ESTALE; fail("lock_replaced"); }
  if (fstatat(root_fd, state_name, &state, AT_SYMLINK_NOFOLLOW) < 0
      || !same(&state_identity, &state) || !private_file(&state)) { errno = ESTALE; fail("state_replaced"); }
}
static void hash_hex(const char *data, size_t length, char output[65]) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data, (CC_LONG)length, digest);
  for (size_t index = 0; index < sizeof(digest); index++) snprintf(output + index * 2, 3, "%02x", digest[index]);
  output[64] = '\0';
}
static void write_all(int fd, const char *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(fd, bytes + offset, length - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) fail("snapshot_write");
    offset += (size_t)written;
  }
}
static void write_frame(int fd, const char *payload, size_t length) {
  if (length == 0 || length + HEADER_SIZE > MAX_STATE) { errno = EFBIG; fail("snapshot_capacity"); }
  char digest[65]; hash_hex(payload, length, digest);
  write_all(fd, magic, sizeof(magic) - 1);
  write_all(fd, key, 64); write_all(fd, "\n", 1);
  write_all(fd, digest, 64); write_all(fd, "\n", 1);
  write_all(fd, payload, length);
}
static char *read_state(size_t *payload_size) {
  struct stat state;
  if (fstat(state_fd, &state) < 0 || !private_file(&state) || state.st_size <= (off_t)HEADER_SIZE || state.st_size > MAX_STATE) {
    errno = EINVAL; fail("state_frame_bound");
  }
  char *bytes = malloc((size_t)state.st_size + 1);
  if (!bytes) fail("snapshot_allocation");
  size_t offset = 0;
  while (offset < (size_t)state.st_size) {
    ssize_t count = pread(state_fd, bytes + offset, (size_t)state.st_size - offset, (off_t)offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) fail("snapshot_read");
    offset += (size_t)count;
  }
  if (memcmp(bytes, magic, sizeof(magic) - 1) != 0 || memcmp(bytes + sizeof(magic) - 1, key, 64) != 0
      || bytes[sizeof(magic) - 1 + 64] != '\n') { errno = EINVAL; fail("state_engine_or_format_conflict"); }
  char digest[65]; hash_hex(bytes + HEADER_SIZE, (size_t)state.st_size - HEADER_SIZE, digest);
  if (memcmp(bytes + sizeof(magic) - 1 + 65, digest, 64) != 0 || bytes[HEADER_SIZE - 1] != '\n') {
    errno = EINVAL; fail("state_checksum");
  }
  *payload_size = (size_t)state.st_size - HEADER_SIZE;
  memmove(bytes, bytes + HEADER_SIZE, *payload_size);
  bytes[*payload_size] = '\0';
  return bytes;
}
static int pending_temp(void) {
  struct stat temporary;
  if (fstatat(root_fd, temp_name, &temporary, AT_SYMLINK_NOFOLLOW) < 0) {
    if (errno == ENOENT) return 0;
    fail("temp_stat");
  }
  if (!private_file(&temporary) || temporary.st_size < 0 || temporary.st_size > MAX_STATE) { errno = EINVAL; fail("temp_conflict"); }
  return 1;
}
static void snapshot(void) {
  assert_paths();
  size_t length; char *payload = read_state(&length);
  printf("{\"kind\":\"snapshot\",\"stateDevice\":%llu,\"stateInode\":%llu,\"pendingTemp\":%s,\"text\":\"",
    (unsigned long long)state_identity.st_dev, (unsigned long long)state_identity.st_ino, pending_temp() ? "true" : "false");
  for (size_t index = 0; index < length; index++) {
    unsigned char value = (unsigned char)payload[index];
    if (value == '\\' || value == '"') { putchar('\\'); putchar(value); }
    else if (value < 0x20) printf("\\u%04x", value);
    else putchar(value);
  }
  puts("\"}"); free(payload);
}
int main(int argc, char **argv) {
  if ((argc != 2 && argc != 3) || strlen(argv[1]) != 64 || strspn(argv[1], "0123456789abcdef") != 64) { errno = EINVAL; fail("arguments"); }
  int bootstrap = argc == 3 && strcmp(argv[2], "bootstrap") == 0;
  cleanup_mode = argc == 3 && strcmp(argv[2], "cleanup") == 0;
  if (argc == 3 && !bootstrap && !cleanup_mode) { errno = EINVAL; fail("mode"); }
  strcpy(key, argv[1]);
  snprintf(lock_name, sizeof(lock_name), "%s.lock", key);
  snprintf(state_name, sizeof(state_name), "%s.state", key);
  snprintf(temp_name, sizeof(temp_name), "%s.next", key);
  umask(0077);
  root_fd = open_root();
  if (fstat(root_fd, &root_identity) < 0 || root_identity.st_uid != getuid() || (root_identity.st_mode & 0777) != 0700) { errno = EPERM; fail("private_root"); }
  if (bootstrap) {
    const char *names[] = { lock_name, state_name, temp_name };
    for (size_t index = 0; index < sizeof(names) / sizeof(names[0]); index++) {
      struct stat existing;
      if (fstatat(root_fd, names[index], &existing, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) {
        errno = EEXIST; fail("bootstrap_existing_authority");
      }
    }
  }
  lock_fd = openat(root_fd, lock_name, O_RDWR | O_NOFOLLOW | O_CLOEXEC | (bootstrap ? O_CREAT | O_EXCL : 0), 0600);
  if (lock_fd < 0) fail("lock_open");
  if (fstat(lock_fd, &lock_identity) < 0 || !private_file(&lock_identity)) { errno = EINVAL; fail("lock_identity"); }
  if (flock(lock_fd, LOCK_EX | LOCK_NB) < 0) fail(errno == EWOULDBLOCK ? "contended" : "lock");
  state_fd = openat(root_fd, state_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (bootstrap) {
    if (state_fd >= 0 || errno != ENOENT) { errno = EEXIST; fail("bootstrap_state_conflict"); }
    state_fd = openat(root_fd, state_name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (state_fd < 0) fail("bootstrap_state");
    const char initial[] = "{\"format\":\"agenai.ms001-snapshot.v1\",\"generation\":\"bootstrap\",\"sequence\":0,\"phase\":\"clean\",\"obligations\":[]}";
    write_frame(state_fd, initial, sizeof(initial) - 1);
    if (fsync(state_fd) < 0 || fsync(root_fd) < 0) fail("bootstrap_sync");
  }
  if (state_fd < 0 || fstat(state_fd, &state_identity) < 0) fail("state_open");
  assert_paths();
  size_t initial_size; char *initial_payload = read_state(&initial_size); free(initial_payload);
  if (pending_temp() && !cleanup_mode) { errno = EINPROGRESS; fail("unpublished_temp"); }
  printf("{\"kind\":\"acquired\",\"device\":%llu,\"inode\":%llu}\n",
    (unsigned long long)lock_identity.st_dev, (unsigned long long)lock_identity.st_ino);
  fflush(stdout);
  char *command = malloc(MAX_STATE + 64);
  if (!command) fail("command_allocation");
  while (fgets(command, MAX_STATE + 64, stdin)) {
    size_t length = strlen(command);
    if (length == 0 || command[length - 1] != '\n') { errno = E2BIG; fail("command_bound"); }
    command[length - 1] = '\0'; assert_paths();
    if (strcmp(command, "SNAPSHOT") == 0) snapshot();
    else if (strcmp(command, "OPEN_TEMP") == 0 && phase == 0) {
      temp_fd = openat(root_fd, temp_name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
      if (temp_fd < 0) fail("temp_open");
      phase = 1; puts("{\"kind\":\"temp_opened\"}");
    } else if (strncmp(command, "WRITE ", 6) == 0 && phase == 1) {
      write_frame(temp_fd, command + 6, strlen(command + 6));
      phase = 2; puts("{\"kind\":\"temp_written\"}");
    } else if (strcmp(command, "SYNC_TEMP") == 0 && phase == 2) {
      if (fsync(temp_fd) < 0) fail("temp_sync");
      phase = 3; puts("{\"kind\":\"temp_synced\"}");
    } else if (strcmp(command, "RENAME") == 0 && phase == 3) {
      if (renameat(root_fd, temp_name, root_fd, state_name) < 0) fail("state_rename");
      close(state_fd); state_fd = temp_fd; temp_fd = -1;
      if (fstat(state_fd, &state_identity) < 0) fail("new_state_stat");
      phase = 4; puts("{\"kind\":\"state_renamed\"}");
    } else if (strcmp(command, "SYNC_DIRECTORY") == 0 && phase == 4) {
      if (fsync(root_fd) < 0) fail("directory_sync");
      phase = 5; puts("{\"kind\":\"directory_synced\"}");
    } else if (strcmp(command, "FINISH") == 0 && phase == 5) {
      size_t count; char *payload = read_state(&count); free(payload);
      phase = 0; puts("{\"kind\":\"committed\"}");
    } else if (strcmp(command, "DISCARD_UNPUBLISHED_TEMP") == 0 && phase == 0 && cleanup_mode) {
      if (!pending_temp()) { errno = ENOENT; fail("temp_missing"); }
      if (unlinkat(root_fd, temp_name, 0) < 0 || fsync(root_fd) < 0) fail("temp_discard");
      puts("{\"kind\":\"unpublished_temp_discarded\"}");
    } else { errno = EINVAL; fail("phase_or_command"); }
    assert_paths();
    if (fflush(stdout) != 0) return 1;
  }
  free(command);
  return ferror(stdin) ? 1 : 0;
}
