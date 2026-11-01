#include "coordinator.h"

#include <errno.h>
#include <fcntl.h>
#include <pwd.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <unistd.h>

bool coordinator_error(struct coordinator_failure *failure, const char *reason, bool lost) {
    *failure = (struct coordinator_failure){ reason, errno, lost };
    return false;
}

bool coordinator_conflict(struct coordinator_failure *failure, const char *reason) {
    errno = ESTALE;
    return coordinator_error(failure, reason, true);
}

bool coordinator_same(const struct stat *left, const struct stat *right) {
    return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

bool coordinator_private_file(const struct stat *value) {
    return S_ISREG(value->st_mode) && value->st_uid == getuid()
        && (value->st_mode & 07777) == 0600 && value->st_nlink == 1;
}

static bool directory_identity(const struct stat *value, bool dedicated) {
    if (!S_ISDIR(value->st_mode)) return false;
    if (dedicated) return value->st_uid == getuid() && (value->st_mode & 07777) == 0700;
    return (value->st_uid == 0 || value->st_uid == getuid()) && (value->st_mode & 0022) == 0;
}

static bool home_directory(struct coordinator *owner, struct coordinator_failure *failure) {
    char *buffer = malloc(1048576U);
    if (!buffer) return coordinator_error(failure, "account_allocation", true);
    struct passwd account, *result = NULL;
    int error = getpwuid_r(getuid(), &account, buffer, 1048576U, &result);
    if (error != 0 || !result || !account.pw_dir || account.pw_dir[0] != '/') {
        free(buffer); errno = error ? error : EINVAL;
        return coordinator_error(failure, "account_home", true);
    }
    size_t length = strlen(account.pw_dir);
    if (length < 2 || length >= sizeof(owner->home) || account.pw_dir[length - 1] == '/') {
        free(buffer); errno = EINVAL;
        return coordinator_error(failure, "account_home", true);
    }
    memcpy(owner->home, account.pw_dir, length + 1);
    free(buffer);
    return true;
}

static int component(int parent, const char *name, bool dedicated, bool create, struct coordinator_failure *failure) {
    bool created = false;
    if (create && mkdirat(parent, name, 0700) == 0) created = true;
    else if (create && errno != EEXIST) { coordinator_error(failure, "directory_create", true); return -1; }
    int child = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (child < 0) { coordinator_error(failure, "directory_open", true); return -1; }
    struct stat value, named;
    if (fstat(child, &value) < 0 || fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) < 0) {
        coordinator_error(failure, "directory_stat", true); close(child); return -1;
    }
    if (!directory_identity(&value, dedicated) || !coordinator_same(&value, &named)) {
        coordinator_conflict(failure, "directory_identity"); close(child); return -1;
    }
    if (created && (fsync(child) < 0 || fsync(parent) < 0)) {
        coordinator_error(failure, "directory_sync", true); close(child); return -1;
    }
    return child;
}

static int authority_root(struct coordinator *owner, bool create, struct coordinator_failure *failure) {
    int current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (current < 0) { coordinator_error(failure, "root_open", true); return -1; }
    struct stat root;
    if (fstat(current, &root) < 0 || !directory_identity(&root, false)) {
        coordinator_conflict(failure, "root_identity"); close(current); return -1;
    }
    char home[sizeof(owner->home)];
    memcpy(home, owner->home, sizeof(home));
    char *cursor = home + 1;
    while (*cursor) {
        char *slash = strchr(cursor, '/');
        if (slash) *slash = '\0';
        if (*cursor == '\0' || strcmp(cursor, ".") == 0 || strcmp(cursor, "..") == 0) {
            coordinator_conflict(failure, "home_component"); close(current); return -1;
        }
        int next = component(current, cursor, false, false, failure);
        close(current);
        if (next < 0) return -1;
        current = next;
        if (!slash) break;
        cursor = slash + 1;
    }
    const char *names[] = { "Library", "Application Support", "AgenAI", "sandbox-docker", "desktop-coordination-v1" };
    for (size_t index = 0; index < sizeof(names) / sizeof(names[0]); index++) {
        int next = component(current, names[index], index >= 2, create, failure);
        close(current);
        if (next < 0) return -1;
        current = next;
    }
    return current;
}

static bool named_file(struct coordinator *owner, const char *name, int descriptor,
    const struct stat *identity, struct coordinator_failure *failure, const char *reason) {
    struct stat named, opened;
    if (fstatat(owner->root_fd, name, &named, AT_SYMLINK_NOFOLLOW) < 0 || fstat(descriptor, &opened) < 0)
        return coordinator_error(failure, reason, true);
    if (!coordinator_private_file(&named) || !coordinator_private_file(&opened)
        || !coordinator_same(identity, &named) || !coordinator_same(identity, &opened))
        return coordinator_conflict(failure, reason);
    return true;
}

bool coordinator_check(struct coordinator *owner, struct coordinator_failure *failure) {
    int root = authority_root(owner, false, failure);
    if (root < 0) return false;
    struct stat current;
    bool valid = fstat(root, &current) == 0;
    close(root);
    if (!valid) return coordinator_error(failure, "root_stat", true);
    if (!coordinator_same(&owner->root_identity, &current)) return coordinator_conflict(failure, "root_substituted");
    if (!named_file(owner, owner->lock_name, owner->lock_fd, &owner->lock_identity, failure, "lock_substituted")
        || !named_file(owner, owner->state_name, owner->state_fd, &owner->state_identity, failure, "state_substituted")) return false;
    struct stat temporary;
    int found = fstatat(owner->root_fd, owner->temp_name, &temporary, AT_SYMLINK_NOFOLLOW);
    if (owner->temp_present) {
        if (found < 0 || !coordinator_private_file(&temporary) || !coordinator_same(&owner->temp_identity, &temporary)
            || temporary.st_size < 0 || temporary.st_size > COORDINATOR_MAX_FRAME)
            return coordinator_conflict(failure, "temp_substituted");
        if (owner->temp_fd >= 0 && !named_file(owner, owner->temp_name, owner->temp_fd,
            &owner->temp_identity, failure, "temp_substituted")) return false;
    } else if (found == 0 || errno != ENOENT) return coordinator_conflict(failure, "temp_unexpected");
    return true;
}

static bool existing_name(struct coordinator *owner, const char *name, bool *exists, struct coordinator_failure *failure) {
    struct stat value;
    if (fstatat(owner->root_fd, name, &value, AT_SYMLINK_NOFOLLOW) == 0) { *exists = true; return true; }
    if (errno == ENOENT) { *exists = false; return true; }
    return coordinator_error(failure, "authority_stat", true);
}

static int open_authority_file(struct coordinator *owner, const char *name, bool bootstrap,
    int access, struct coordinator_failure *failure) {
    struct stat before, after;
    if (!bootstrap) {
        if (fstatat(owner->root_fd, name, &before, AT_SYMLINK_NOFOLLOW) < 0) {
            coordinator_error(failure, "authority_stat", true); return -1;
        }
        if (!coordinator_private_file(&before)) {
            coordinator_conflict(failure, "authority_file_identity"); return -1;
        }
    }
    int descriptor = openat(owner->root_fd, name,
        access | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC | (bootstrap ? O_CREAT | O_EXCL : 0), 0600);
    if (descriptor < 0) { coordinator_error(failure, "authority_open", true); return -1; }
    if (fstat(descriptor, &after) < 0) {
        coordinator_error(failure, "authority_stat", true); close(descriptor); return -1;
    }
    if (!coordinator_private_file(&after) || (!bootstrap && !coordinator_same(&before, &after))) {
        coordinator_conflict(failure, "authority_file_substituted"); close(descriptor); return -1;
    }
    return descriptor;
}

bool coordinator_open(struct coordinator *owner, enum coordinator_mode mode, struct coordinator_failure *failure) {
    owner->cleanup = mode == MODE_CLEANUP;
    if (!home_directory(owner, failure)) return false;
    owner->root_fd = authority_root(owner, mode == MODE_INITIALIZE, failure);
    if (owner->root_fd < 0) return false;
    if (fstat(owner->root_fd, &owner->root_identity) < 0) return coordinator_error(failure, "root_stat", true);
    bool lock_exists, state_exists, temp_exists;
    if (!existing_name(owner, owner->lock_name, &lock_exists, failure)
        || !existing_name(owner, owner->state_name, &state_exists, failure)
        || !existing_name(owner, owner->temp_name, &temp_exists, failure)) return false;
    bool bootstrap = mode == MODE_INITIALIZE && !lock_exists && !state_exists && !temp_exists;
    if (!bootstrap && (!lock_exists || !state_exists)) { errno = ENOENT; return coordinator_error(failure, "authority_partial", true); }
    owner->lock_fd = open_authority_file(owner, owner->lock_name, bootstrap, O_RDWR, failure);
    if (owner->lock_fd < 0) return false;
    if (fstat(owner->lock_fd, &owner->lock_identity) < 0) return coordinator_error(failure, "lock_stat", true);
    if (!coordinator_private_file(&owner->lock_identity)) return coordinator_conflict(failure, "lock_identity");
    if (flock(owner->lock_fd, LOCK_EX | LOCK_NB) < 0)
        return coordinator_error(failure, errno == EWOULDBLOCK ? "busy" : "lock_acquire", true);
    owner->claimed = true;
    owner->state_fd = open_authority_file(owner, owner->state_name, bootstrap, O_RDONLY, failure);
    if (owner->state_fd < 0) return false;
    if (fstat(owner->state_fd, &owner->state_identity) < 0) return coordinator_error(failure, "state_stat", true);
    if (!coordinator_private_file(&owner->state_identity)) return coordinator_conflict(failure, "state_identity");
    owner->initial_required = bootstrap;
    if (temp_exists) {
        if (fstatat(owner->root_fd, owner->temp_name, &owner->temp_identity, AT_SYMLINK_NOFOLLOW) < 0)
            return coordinator_error(failure, "temp_stat", true);
        owner->temp_present = true;
    }
    if (!coordinator_check(owner, failure)) return false;
    if (bootstrap && (fsync(owner->lock_fd) < 0 || fsync(owner->root_fd) < 0))
        return coordinator_error(failure, "bootstrap_sync", false);
    if (!bootstrap) {
        char *payload = NULL, digest[65]; size_t length;
        if (!coordinator_read(owner, &payload, &length, digest, failure)) return false;
        free(payload);
    }
    if (owner->temp_present && mode != MODE_CLEANUP) {
        errno = EINPROGRESS; return coordinator_error(failure, "unpublished_temp", false);
    }
    return true;
}

void coordinator_close(struct coordinator *owner) {
    if (owner->temp_fd >= 0) { close(owner->temp_fd); owner->temp_fd = -1; }
    if (owner->state_fd >= 0) { close(owner->state_fd); owner->state_fd = -1; }
    if (owner->lock_fd >= 0) { close(owner->lock_fd); owner->lock_fd = -1; }
    if (owner->root_fd >= 0) { close(owner->root_fd); owner->root_fd = -1; }
    owner->claimed = false;
}
