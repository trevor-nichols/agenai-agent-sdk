/* MS001 research only. No Docker calls; the preparation step fixes a scratch root. */
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef RESEARCH_ROOT
#error "Explicit preparation must supply RESEARCH_ROOT."
#endif
#ifndef __APPLE__
#error "This prototype qualifies Darwin only."
#endif

#define MAX_JOURNAL (512 * 1024)
#define MAX_COMMAND (64 * 1024)

static const char initial[] = "{\"kind\":\"empty\",\"version\":1}\n";
static int root_fd, journal_fd;
static struct stat root_identity, journal_identity;
static char filename[80];

static void fail(const char *reason) {
  fprintf(stdout, "{\"kind\":\"failure\",\"reason\":\"%s\",\"errno\":%d}\n", reason, errno);
  fflush(stdout);
  exit(1);
}

static int same_file(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static int open_root(void) {
  char path[PATH_MAX];
  if (strlen(RESEARCH_ROOT) >= sizeof(path) || RESEARCH_ROOT[0] != '/') {
    errno = EINVAL;
    fail("research_root");
  }
  strcpy(path, RESEARCH_ROOT);
  int current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (current < 0) fail("root_open");
  char *remaining = NULL;
  for (char *part = strtok_r(path, "/", &remaining); part; part = strtok_r(NULL, "/", &remaining)) {
    int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) fail("root_component");
    close(current);
    current = next;
  }
  return current;
}

static void assert_paths(void) {
  struct stat current_root, current_journal, held_journal;
  int reopened = open_root();
  if (fstat(reopened, &current_root) < 0) fail("root_stat");
  close(reopened);
  if (!same_file(&root_identity, &current_root) || current_root.st_uid != getuid()
      || (current_root.st_mode & 0777) != 0700) { errno = ESTALE; fail("root_replaced"); }
  if (fstatat(root_fd, filename, &current_journal, AT_SYMLINK_NOFOLLOW) < 0
      || fstat(journal_fd, &held_journal) < 0) fail("journal_stat");
  if (!same_file(&journal_identity, &current_journal) || !same_file(&journal_identity, &held_journal)
      || !S_ISREG(current_journal.st_mode) || current_journal.st_uid != getuid()
      || (current_journal.st_mode & 0777) != 0600 || current_journal.st_nlink != 1) {
    errno = ESTALE;
    fail("journal_replaced");
  }
}

static void append(const char *data, size_t length) {
  assert_paths();
  struct stat status;
  if (fstat(journal_fd, &status) < 0) fail("journal_stat");
  if (status.st_size < 0 || (size_t)status.st_size + length > MAX_JOURNAL) {
    errno = EFBIG;
    fail("journal_capacity");
  }
  if (lseek(journal_fd, 0, SEEK_END) < 0) fail("journal_seek");
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(journal_fd, data + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) fail("journal_write");
    offset += (size_t)count;
  }
  if (fsync(journal_fd) < 0) fail("journal_sync");
  assert_paths();
}

static void snapshot(void) {
  assert_paths();
  struct stat status;
  if (fstat(journal_fd, &status) < 0 || status.st_size < 0 || status.st_size > MAX_JOURNAL) {
    errno = EFBIG;
    fail("journal_size");
  }
  char *data = malloc((size_t)status.st_size + 1);
  if (!data) fail("snapshot_allocation");
  size_t length = 0;
  while (length < (size_t)status.st_size) {
    ssize_t count = pread(journal_fd, data + length, (size_t)status.st_size - length, (off_t)length);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) fail("snapshot_read");
    length += (size_t)count;
  }
  fputs("{\"kind\":\"snapshot\",\"text\":\"", stdout);
  for (size_t index = 0; index < length; index++) {
    unsigned char value = (unsigned char)data[index];
    if (value == '\\' || value == '"') { putchar('\\'); putchar(value); }
    else if (value < 0x20) printf("\\u%04x", value);
    else putchar(value);
  }
  puts("\"}");
  free(data);
}

static void duplicate_open(void) {
  assert_paths();
  int duplicate = openat(root_fd, filename, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  if (duplicate < 0) fail("duplicate_open");
  int result = flock(duplicate, LOCK_EX | LOCK_NB);
  int saved = errno;
  close(duplicate);
  if (result == 0 || saved != EWOULDBLOCK) { errno = saved; fail("duplicate_not_excluded"); }
  puts("{\"kind\":\"duplicate_excluded\"}");
}

static void exec_child(void) {
  pid_t child = fork();
  if (child < 0) fail("fork");
  if (child == 0) {
    execl("/bin/sleep", "sleep", "30", (char *)NULL);
    _exit(127);
  }
  printf("{\"kind\":\"exec_child\",\"pid\":%d}\n", child);
}

int main(int argc, char **argv) {
  if (argc != 2 || strlen(argv[1]) != 64 || strspn(argv[1], "0123456789abcdef") != 64) {
    errno = EINVAL;
    fail("engine_key");
  }
  signal(SIGPIPE, SIG_IGN);
  signal(SIGXFSZ, SIG_IGN);
  umask(0077);
  root_fd = open_root();
  if (fstat(root_fd, &root_identity) < 0 || !S_ISDIR(root_identity.st_mode)
      || root_identity.st_uid != getuid() || (root_identity.st_mode & 0777) != 0700) {
    errno = EPERM;
    fail("private_root");
  }
  snprintf(filename, sizeof(filename), "%s.journal", argv[1]);
  int created = 1;
  journal_fd = openat(root_fd, filename, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (journal_fd < 0 && errno == EEXIST) {
    created = 0;
    journal_fd = openat(root_fd, filename, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  }
  if (journal_fd < 0) fail("journal_open");
  if (fstat(journal_fd, &journal_identity) < 0) fail("journal_stat");
  assert_paths();
  if (flock(journal_fd, LOCK_EX | LOCK_NB) < 0) fail(errno == EWOULDBLOCK ? "contended" : "lock");
  assert_paths();
  if (created) {
    append(initial, sizeof(initial) - 1);
    if (fsync(root_fd) < 0) fail("root_sync");
  }
  printf("{\"kind\":\"acquired\",\"pid\":%d,\"device\":%llu,\"inode\":%llu}\n", getpid(),
    (unsigned long long)journal_identity.st_dev, (unsigned long long)journal_identity.st_ino);
  fflush(stdout);
  char command[MAX_COMMAND + 1];
  while (fgets(command, sizeof(command), stdin)) {
    size_t length = strlen(command);
    if (length == 0 || command[length - 1] != '\n') { errno = E2BIG; fail("command_bound"); }
    command[--length] = '\0';
    if (strcmp(command, "CHECK") == 0) { assert_paths(); puts("{\"kind\":\"checked\"}"); }
    else if (strcmp(command, "SNAPSHOT") == 0) snapshot();
    else if (strcmp(command, "DUPLICATE") == 0) duplicate_open();
    else if (strcmp(command, "EXEC_CHILD") == 0) exec_child();
    else if (strcmp(command, "CLOSE") == 0) return 0;
    else if (strncmp(command, "APPEND ", 7) == 0) {
      command[length] = '\n';
      append(command + 7, length - 6);
      puts("{\"kind\":\"durable\"}");
    } else { errno = EINVAL; fail("command"); }
    if (fflush(stdout) != 0) return 1;
  }
  /* Pipe EOF is parent death/close, never a clean-state receipt. */
  return ferror(stdin) ? 1 : 0;
}
