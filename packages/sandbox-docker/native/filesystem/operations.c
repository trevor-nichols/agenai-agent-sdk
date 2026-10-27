// Linux descriptor-relative observations and staged name publication; no pathname-following fallback.
#define _GNU_SOURCE
#include "filesystem.h"
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <stdio.h>
#include <string.h>
#include <sys/random.h>
#include <sys/syscall.h>
#include <unistd.h>

#define RESOLUTION (RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV)

static int beneath(int base, const char *path, int flags) {
  struct open_how how = { .flags = (__u64)(unsigned int)(flags | O_CLOEXEC | O_NOFOLLOW), .resolve = RESOLUTION };
  return (int)syscall(SYS_openat2, base, path, &how, sizeof(how));
}
static bool same_inode(const struct stat *a, const struct stat *b) { return a->st_dev == b->st_dev && a->st_ino == b->st_ino; }
static bool same_observation(const struct stat *a, const struct stat *b) {
  return same_inode(a, b) && a->st_size == b->st_size && a->st_nlink == b->st_nlink && a->st_mode == b->st_mode
    && a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec
    && a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}
static bool directory_identity(const struct stat *entry) {
  return S_ISDIR(entry->st_mode) && entry->st_uid == geteuid() && entry->st_gid == getegid() && (entry->st_mode & 07777) == 0700;
}
static bool path_current(struct filesystem *fs, const char *path, const struct stat *before) {
  struct stat store, root, actual;
  int fd = beneath(fs->root, path, O_PATH);
  bool current = fd >= 0 && fstat(fd, &actual) == 0 && same_inode(&actual, before)
    && lstat("/store", &store) == 0 && same_inode(&store, &fs->store_identity)
    && fstatat(fs->store, "work", &root, AT_SYMLINK_NOFOLLOW) == 0 && same_inode(&root, &fs->root_identity);
  if (fd >= 0) close(fd);
  return current;
}

// Reject malformed UTF-8 and the same control/backslash characters as the public path boundary.
static bool valid_text(const unsigned char *text, size_t size) {
  for (size_t index = 0; index < size;) {
    uint32_t point = text[index++];
    if (point < 0x80) { if (point < 0x20 || point == 0x7f || point == '\\') return false; continue; }
    unsigned continuation;
    uint32_t minimum;
    if (point >= 0xc2 && point <= 0xdf) { continuation = 1; minimum = 0x80; point &= 0x1f; }
    else if (point >= 0xe0 && point <= 0xef) { continuation = 2; minimum = 0x800; point &= 0x0f; }
    else if (point >= 0xf0 && point <= 0xf4) { continuation = 3; minimum = 0x10000; point &= 0x07; }
    else return false;
    if (index + continuation > size) return false;
    for (unsigned next = 0; next < continuation; next++) {
      unsigned char byte = text[index++];
      if ((byte & 0xc0) != 0x80) return false;
      point = (point << 6) | (byte & 0x3f);
    }
    if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) || (point >= 0x80 && point <= 0x9f)) return false;
  }
  return true;
}
bool valid_path(const char *path, size_t size, bool root_allowed) {
  if (!size || size > PATH_BYTES || path[0] == '/' || !valid_text((const unsigned char *)path, size)) return false;
  if (size == 1 && path[0] == '.') return root_allowed;
  unsigned components = 0;
  size_t start = 0;
  for (size_t index = 0; index <= size; index++) {
    if (index != size && path[index] != '/') continue;
    size_t length = index - start;
    if (++components > COMPONENTS || !length || length > 255 || (length == 1 && path[start] == '.')
      || (length == 2 && path[start] == '.' && path[start + 1] == '.')) return false;
    start = index + 1;
  }
  return true;
}

int filesystem_open(struct filesystem *fs, bool writable) {
  memset(fs, 0, sizeof(*fs));
  fs->store = fs->root = fs->stage = fs->file = fs->parent = -1;
  fs->writable = writable;
  if (!geteuid() || !getegid()) { errno = EPERM; return -1; }
  fs->store = open("/store", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fs->store < 0 || fstat(fs->store, &fs->store_identity) || !directory_identity(&fs->store_identity)) { errno = EPERM; return -1; }
  fs->root = beneath(fs->store, "work", O_PATH | O_DIRECTORY);
  fs->stage = beneath(fs->store, "stage", O_RDONLY | O_DIRECTORY);
  struct stat stage, marker;
  if (fs->root < 0 || fs->stage < 0 || fstat(fs->root, &fs->root_identity) || fstat(fs->stage, &stage)
    || !directory_identity(&fs->root_identity) || !directory_identity(&stage)
    || fs->root_identity.st_dev != fs->store_identity.st_dev || stage.st_dev != fs->root_identity.st_dev
    || same_inode(&stage, &fs->root_identity)) { errno = EPERM; return -1; }
  int fd = beneath(fs->store, ".agenai-layout", O_RDONLY | O_NONBLOCK);
  char expected[256], actual[256];
  int length = snprintf(expected, sizeof(expected), "{\"layout\":\"%s\",\"uid\":%u,\"gid\":%u}\n", FILESYSTEM_LAYOUT, (unsigned)geteuid(), (unsigned)getegid());
  bool valid = fd >= 0 && fstat(fd, &marker) == 0 && S_ISREG(marker.st_mode) && marker.st_nlink == 1
    && marker.st_uid == geteuid() && marker.st_gid == getegid() && (marker.st_mode & 07777) == 0400
    && marker.st_dev == fs->root_identity.st_dev && length > 0 && marker.st_size == length
    && read(fd, actual, sizeof(actual)) == length && !memcmp(expected, actual, (size_t)length);
  if (fd >= 0) close(fd);
  if (!valid) { errno = EPERM; return -1; }
  return 0;
}

int filesystem_cleanup(struct filesystem *fs) {
  int error = 0;
  if (fs->directory) { if (closedir(fs->directory)) error = errno; fs->directory = NULL; fs->file = -1; }
  else if (fs->file >= 0 && close(fs->file)) error = errno;
  fs->file = -1;
  if (fs->staged[0]) {
    if (unlinkat(fs->stage, fs->staged, 0) && errno != ENOENT) error = errno;
    else fs->staged[0] = '\0';
  }
  if (fs->parent >= 0 && close(fs->parent) && !error) error = errno;
  fs->parent = -1;
  fs->changed = false;
  fs->activity = fs->staged[0] ? ACTIVITY_WRITE : ACTIVITY_IDLE;
  return error;
}
static const char *entry_kind(const struct stat *entry) {
  if (S_ISREG(entry->st_mode)) return entry->st_nlink == 1 ? "file" : "unsupported_hardlink";
  if (S_ISDIR(entry->st_mode)) return "directory";
  if (S_ISLNK(entry->st_mode)) return "symlink";
  return "unsupported_special";
}
static bool metadata(const struct stat *entry, char *json, size_t capacity) {
  if (entry->st_size < 0 || (uint64_t)entry->st_size > MAX_SAFE_INTEGER) { errno = EOVERFLOW; return false; }
  int length = snprintf(json, capacity, "{\"kind\":\"%s\",\"byteLength\":%llu,\"mode\":%u}", entry_kind(entry),
    (unsigned long long)entry->st_size, (unsigned)(entry->st_mode & 0777));
  return length > 0 && (size_t)length < capacity;
}
static void finish(struct filesystem *fs, const char *status, int error) {
  uint64_t count = fs->count;
  int cleanup_error = filesystem_cleanup(fs);
  terminal(cleanup_error ? "cleanup_failed" : status, fs->staged[0] ? "staged" : "none", cleanup_error ? cleanup_error : error, count, -1, NULL);
}
void filesystem_cancel(struct filesystem *fs, bool close) { finish(fs, close ? "closed" : "cancelled", 0); }

void filesystem_stat(struct filesystem *fs, const char *path) {
  int fd = beneath(fs->root, path, O_PATH);
  struct stat info;
  char json[256];
  if (fd < 0) { terminal("rejected", "none", errno, 0, -1, NULL); return; }
  int error = fstat(fd, &info) ? errno : 0;
  if (!error && !metadata(&info, json, sizeof(json))) error = errno;
  bool current = !error && path_current(fs, path, &info);
  if (close(fd) && !error) error = errno;
  terminal(error ? "failed" : current ? "complete" : "changed", "none", error, 0, -1, error ? NULL : json);
}

// A trusted proc descriptor reopens the admitted regular inode, never a guest-supplied magic link.
void filesystem_read(struct filesystem *fs, const char *path) {
  fs->count = 0;
  int reference = beneath(fs->root, path, O_PATH);
  struct stat actual;
  int error = 0;
  if (reference < 0) { terminal("rejected", "none", errno, 0, -1, NULL); return; }
  if (fstat(reference, &fs->before)) error = errno;
  else if (!S_ISREG(fs->before.st_mode)) error = EOPNOTSUPP;
  else if (fs->before.st_nlink != 1) error = EMLINK;
  char proc[64], json[256];
  if (!error && !metadata(&fs->before, json, sizeof(json))) error = errno;
  snprintf(proc, sizeof(proc), "/proc/self/fd/%d", reference);
  if (!error) { fs->file = open(proc, O_RDONLY | O_NONBLOCK | O_CLOEXEC); if (fs->file < 0) error = errno; }
  close(reference);
  if (!error && (fstat(fs->file, &actual) || !same_observation(&actual, &fs->before))) error = ESTALE;
  if (error) { finish(fs, "rejected", error); return; }
  strcpy(fs->path, path);
  fs->count = 0;
  fs->activity = ACTIVITY_READ;
  terminal("ready", "none", 0, 0, -1, json);
}
void filesystem_list(struct filesystem *fs, const char *path) {
  fs->count = 0;
  fs->file = beneath(fs->root, path, O_RDONLY | O_DIRECTORY);
  if (fs->file < 0) { terminal("rejected", "none", errno, 0, -1, NULL); return; }
  char json[256];
  if (fstat(fs->file, &fs->before) || !metadata(&fs->before, json, sizeof(json))) { finish(fs, "failed", errno); return; }
  fs->directory = fdopendir(fs->file);
  if (!fs->directory) { finish(fs, "failed", errno); return; }
  strcpy(fs->path, path);
  fs->count = 0;
  fs->changed = false;
  fs->activity = ACTIVITY_LIST;
  terminal("ready", "none", 0, 0, -1, json);
}
static bool unchanged(struct filesystem *fs) {
  struct stat after;
  return !fs->changed && fstat(fs->file, &after) == 0 && same_observation(&after, &fs->before) && path_current(fs, fs->path, &fs->before);
}
void filesystem_next(struct filesystem *fs) {
  if (fs->activity == ACTIVITY_READ) {
    if (fs->count >= (uint64_t)fs->before.st_size) { finish(fs, unchanged(fs) ? "complete" : "changed", 0); return; }
    unsigned char bytes[CHUNK_BYTES];
    uint64_t remaining = (uint64_t)fs->before.st_size - fs->count;
    size_t wanted = remaining < CHUNK_BYTES ? (size_t)remaining : CHUNK_BYTES;
    ssize_t count;
    do { count = read(fs->file, bytes, wanted); } while (count < 0 && errno == EINTR && !stopping);
    if (count < 0) { finish(fs, "failed", errno); return; }
    if (!count) { finish(fs, "changed", 0); return; }
    fs->count += (uint64_t)count;
    (void)transport_frame(REPLY_BYTES, bytes, (size_t)count);
    return;
  }
  if (fs->activity == ACTIVITY_LIST) {
    while (!stopping) {
      errno = 0;
      struct dirent *entry = readdir(fs->directory);
      if (!entry) { int error = errno; finish(fs, error ? "failed" : unchanged(fs) ? "complete" : "changed", error); return; }
      if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
      size_t size = strlen(entry->d_name);
      if (!valid_path(entry->d_name, size, false)) { finish(fs, "rejected", EILSEQ); return; }
      size_t prefix = !strcmp(fs->path, ".") ? 0 : strlen(fs->path) + 1;
      if (prefix + size > PATH_BYTES) { finish(fs, "rejected", ENAMETOOLONG); return; }
      char child_path[PATH_BYTES + 1];
      if (prefix) { memcpy(child_path, fs->path, prefix - 1); child_path[prefix - 1] = '/'; }
      memcpy(child_path + prefix, entry->d_name, size + 1);
      if (!valid_path(child_path, prefix + size, false)) { finish(fs, "rejected", ENAMETOOLONG); return; }
      struct stat info;
      if (fstatat(fs->file, entry->d_name, &info, AT_SYMLINK_NOFOLLOW)) {
        int error = errno;
        if (error == ENOENT) { fs->changed = true; continue; }
        finish(fs, error == EACCES || error == EPERM ? "rejected" : "failed", error); return;
      }
      if (info.st_size < 0 || (uint64_t)info.st_size > MAX_SAFE_INTEGER || fs->count == UINT64_MAX) { finish(fs, "failed", EOVERFLOW); return; }
      char hex[511], json[METADATA_BYTES];
      for (size_t index = 0; index < size; index++) snprintf(hex + index * 2, 3, "%02x", (unsigned char)entry->d_name[index]);
      int length = snprintf(json, sizeof(json), "{\"nameHex\":\"%s\",\"kind\":\"%s\",\"byteLength\":%llu,\"mode\":%u}",
        hex, entry_kind(&info), (unsigned long long)info.st_size, (unsigned)(info.st_mode & 0777));
      fs->count++;
      (void)transport_frame(REPLY_ENTRY, json, (size_t)length);
      return;
    }
    return;
  }
  terminal("rejected", "none", EINVAL, 0, -1, NULL);
}

static int inspect_target(struct filesystem *fs, mode_t *mode) {
  struct stat target;
  if (fstatat(fs->parent, fs->target, &target, AT_SYMLINK_NOFOLLOW)) {
    if (errno == ENOENT) { *mode = 0644; return 0; }
    return -1;
  }
  if (!S_ISREG(target.st_mode)) { errno = EOPNOTSUPP; return -1; }
  if (target.st_nlink != 1) { errno = EMLINK; return -1; }
  *mode = target.st_mode & 0777;
  return 1;
}
void filesystem_write(struct filesystem *fs, const char *path, unsigned mode) {
  if (!fs->writable || (mode != 1 && mode != 2)) { terminal("rejected", "none", EPERM, 0, -1, NULL); return; }
  strcpy(fs->path, path);
  strcpy(fs->parent_path, path);
  char *slash = strrchr(fs->parent_path, '/');
  if (slash) { strcpy(fs->target, slash + 1); *slash = '\0'; }
  else { strcpy(fs->target, path); strcpy(fs->parent_path, "."); }
  fs->count = 0;
  fs->parent = beneath(fs->root, fs->parent_path, O_RDONLY | O_DIRECTORY);
  if (fs->parent < 0) { terminal("rejected", "none", errno, 0, -1, NULL); return; }
  mode_t permissions;
  int exists = inspect_target(fs, &permissions);
  if (exists < 0 || (mode == 1 && exists)) { finish(fs, "rejected", exists < 0 ? errno : EEXIST); return; }
  uint64_t nonce;
  if (getrandom(&nonce, sizeof(nonce), 0) != sizeof(nonce)) { finish(fs, "failed", errno ? errno : EIO); return; }
  snprintf(fs->staged, sizeof(fs->staged), "staged-%016llx", (unsigned long long)nonce);
  fs->file = openat(fs->stage, fs->staged, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fs->file < 0) { fs->staged[0] = '\0'; finish(fs, "failed", errno); return; }
  fs->write_mode = mode;
  fs->activity = ACTIVITY_WRITE;
  terminal("ready", "staged", 0, 0, -1, NULL);
}
void filesystem_append(struct filesystem *fs, const void *bytes, size_t size) {
  if (fs->activity != ACTIVITY_WRITE || fs->file < 0) { terminal("rejected", fs->staged[0] ? "staged" : "none", EINVAL, fs->count, -1, NULL); return; }
  if (UINT64_MAX - fs->count < size) { finish(fs, "failed", EOVERFLOW); return; }
  size_t offset = 0;
  while (offset < size && !stopping) {
    ssize_t count = write(fs->file, (const char *)bytes + offset, size - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { finish(fs, "failed", count ? errno : EIO); return; }
    offset += (size_t)count;
    fs->count += (uint64_t)count;
  }
  terminal("ready", "staged", 0, fs->count, -1, NULL);
}
void filesystem_commit(struct filesystem *fs) {
  if (fs->activity != ACTIVITY_WRITE || fs->file < 0) { terminal("rejected", fs->staged[0] ? "staged" : "none", EINVAL, fs->count, -1, NULL); return; }
  mode_t permissions;
  int exists = inspect_target(fs, &permissions);
  struct stat parent, staged, current;
  if (exists < 0 || (fs->write_mode == 1 && exists)) { finish(fs, "rejected", exists < 0 ? errno : EEXIST); return; }
  if (fstat(fs->parent, &parent) || fstat(fs->file, &staged) || fchmod(fs->file, permissions)) { finish(fs, "failed", errno); return; }
  if (syscall(SYS_renameat2, fs->stage, fs->staged, fs->parent, fs->target, fs->write_mode == 1 ? RENAME_NOREPLACE : 0)) { finish(fs, "rejected", errno); return; }
  fs->staged[0] = '\0';
  bool observed = path_current(fs, fs->parent_path, &parent) && fstatat(fs->parent, fs->target, &current, AT_SYMLINK_NOFOLLOW) == 0 && same_inode(&current, &staged);
  uint64_t count = fs->count;
  int cleanup_error = filesystem_cleanup(fs);
  terminal(cleanup_error ? "uncertain" : observed ? "complete" : "changed", "published", cleanup_error, count, (int)permissions, NULL);
}
