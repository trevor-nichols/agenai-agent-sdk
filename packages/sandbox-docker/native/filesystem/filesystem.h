// Descriptor-owned operation state, shared only by the trusted helper's serial dispatcher.
#ifndef AGENAI_FILESYSTEM_H
#define AGENAI_FILESYSTEM_H

#include "protocol.h"
#include <dirent.h>
#include <sys/stat.h>

enum activity { ACTIVITY_IDLE, ACTIVITY_READ, ACTIVITY_LIST, ACTIVITY_WRITE };
struct filesystem {
  int store, root, stage, file, parent;
  DIR *directory;
  bool writable, changed;
  enum activity activity;
  struct stat store_identity, root_identity, before;
  char path[PATH_BYTES + 1], parent_path[PATH_BYTES + 1], target[256], staged[64];
  unsigned write_mode;
  uint64_t count;
};

bool valid_path(const char *path, size_t size, bool root_allowed);
int filesystem_open(struct filesystem *fs, bool writable);
int filesystem_cleanup(struct filesystem *fs);
void filesystem_stat(struct filesystem *fs, const char *path);
void filesystem_read(struct filesystem *fs, const char *path);
void filesystem_list(struct filesystem *fs, const char *path);
void filesystem_next(struct filesystem *fs);
void filesystem_write(struct filesystem *fs, const char *path, unsigned mode);
void filesystem_append(struct filesystem *fs, const void *bytes, size_t size);
void filesystem_commit(struct filesystem *fs);
void filesystem_cancel(struct filesystem *fs, bool close);

#endif
