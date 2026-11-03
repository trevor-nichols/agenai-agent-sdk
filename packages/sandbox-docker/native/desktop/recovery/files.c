#include "recovery.h"
#include "profile.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <time.h>
#include <unistd.h>

bool recovery_file_open(const char *path, struct file_fact *file, bool writable, struct coordinator_failure *f) {
    (void)writable;
    if (path[0] != '/' || strlen(path) >= sizeof(file->path)) return recovery_fail(f, "file_path_bound");
    char copy[4096]; strcpy(copy, path); int parent = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (parent < 0) return coordinator_error(f, "file_root", false);
    char *part = copy + 1;
    for (unsigned components = 0;; components++) {
        if (components == 256U || !*part || strcmp(part, ".") == 0 || strcmp(part, "..") == 0) { close(parent); return recovery_fail(f, "file_component"); }
        char *slash = strchr(part, '/'); if (slash) *slash = 0;
        int fd = openat(parent, part, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | (slash ? O_DIRECTORY : 0));
        struct stat identity, named;
        if (fd < 0) { close(parent); return coordinator_error(f, "file_open", false); }
        bool ok = fstat(fd, &identity) == 0 && fstatat(parent, part, &named, AT_SYMLINK_NOFOLLOW) == 0;
        close(parent);
        unsigned forbidden_mode = slash && identity.st_uid == 0 ? 0002U : 0022U;
        if (!ok || !coordinator_same(&identity, &named) || (identity.st_uid != 0 && identity.st_uid != getuid())
            || (identity.st_mode & forbidden_mode) != 0 || (slash ? !S_ISDIR(identity.st_mode) : !S_ISREG(identity.st_mode))) {
            close(fd); return recovery_fail(f, "file_identity");
        }
        if (!slash) { file->fd = fd; file->identity = identity; strcpy(file->path, path); return true; }
        parent = fd; part = slash + 1;
    }
}
bool recovery_file_check(const struct file_fact *file, struct coordinator_failure *f) {
    struct file_fact current = { .fd = -1 }; struct stat held;
    if (!recovery_file_open(file->path, &current, false, f)) return false;
    bool ok = fstat(file->fd, &held) == 0 && coordinator_same(&current.identity, &file->identity) && coordinator_same(&held, &file->identity)
        && held.st_uid == file->identity.st_uid && (held.st_mode & 07777) == (file->identity.st_mode & 07777)
        && held.st_birthtimespec.tv_sec == file->identity.st_birthtimespec.tv_sec && held.st_birthtimespec.tv_nsec == file->identity.st_birthtimespec.tv_nsec;
    close(current.fd); return ok ? true : recovery_fail(f, "file_replaced");
}
static bool fixed_file(struct recovery *r, const char *relative, struct file_fact *file, struct coordinator_failure *f) {
    char path[4096]; int n = snprintf(path, sizeof(path), "%s/%s", r->owner.home, relative);
    if (n < 0 || n >= (int)sizeof(path)) return recovery_fail(f, "file_path_bound");
    if (file->fd >= 0) close(file->fd); file->fd = -1;
    return recovery_file_open(path, file, false, f);
}
static bool metadata_file(struct recovery *r, const char *source, struct file_fact *file, struct coordinator_failure *f) {
    if (strcmp(source, "components") == 0) {
        if (file->fd >= 0) close(file->fd); file->fd = -1;
        return recovery_file_open(RECOVERY_APPLICATION "/Contents/Resources/componentsVersion.json", file, false, f);
    }
    if (strcmp(source, "settings") == 0) return fixed_file(r, "Library/Group Containers/group.com.docker/settings-store.json", file, f);
    return recovery_fail(f, "metadata_source");
}
static bool metadata_hash(struct file_fact *file, char sha[65], struct coordinator_failure *f) {
    if (file->identity.st_size <= 0 || file->identity.st_size > 1048576) return recovery_fail(f, "metadata_bound");
    if (!recovery_hash_fd(file->fd, 1048576, sha, f) || !recovery_file_check(file, f)) return false;
    if (fstat(file->fd, &file->identity) < 0) return coordinator_error(f, "metadata_stat", false);
    return true;
}
bool recovery_files_admission(struct recovery *r, struct json *j, struct coordinator_failure *f) {
    if (r->disk.fd < 0 && !fixed_file(r, "Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw", &r->disk, f)) return false;
    if (!recovery_file_check(&r->disk, f)) return false;
    if (!metadata_file(r, "components", &r->components, f) || !metadata_file(r, "settings", &r->settings, f)) return false;
    char component_sha[65], settings_sha[65];
    if (!metadata_hash(&r->components, component_sha, f) || !metadata_hash(&r->settings, settings_sha, f)) return false;
    if (strcmp(component_sha, RECOVERY_COMPONENTS_SHA) != 0) return recovery_fail(f, "components_version_hash");
    char parent_path[4096]; strcpy(parent_path, r->disk.path); char *slash = strrchr(parent_path, '/'); *slash = 0;
    int parent = open(parent_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); struct stat p;
    if (parent < 0 || fstat(parent, &p) < 0) { if (parent >= 0) close(parent); return coordinator_error(f, "store_parent", false); } close(parent);
    const struct stat *s = &r->disk.identity;
    json_raw(j, "\"store\":{\"parentDevice\":\"%llu\",\"parentInode\":\"%llu\",\"device\":\"%llu\",\"inode\":\"%llu\",\"uid\":\"%u\",\"mode\":\"%u\",\"birthSeconds\":\"%llu\",\"birthNanoseconds\":\"%ld\"},",
        (unsigned long long)p.st_dev, (unsigned long long)p.st_ino, (unsigned long long)s->st_dev, (unsigned long long)s->st_ino,
        s->st_uid, s->st_mode & 07777, (unsigned long long)s->st_birthtimespec.tv_sec, s->st_birthtimespec.tv_nsec);
    json_raw(j, "\"metadata\":{\"components\":{\"sha256\":\"%s\",\"bytes\":%llu},\"settings\":{\"sha256\":\"%s\",\"bytes\":%llu}}",
        component_sha, (unsigned long long)r->components.identity.st_size, settings_sha, (unsigned long long)r->settings.identity.st_size);
    return true;
}
static bool metadata_observe(struct recovery *r, const char *source, struct json *j, struct coordinator_failure *f) {
    struct file_fact file = { .fd = -1 }; if (!metadata_file(r, source, &file, f)) return false;
    char sha[65]; if (!metadata_hash(&file, sha, f)) { close(file.fd); return false; }
    size_t n = (size_t)file.identity.st_size; unsigned char *bytes = malloc(n); if (!bytes) { close(file.fd); return coordinator_error(f, "metadata_allocation", false); }
    size_t at = 0;
    while (at < n) { ssize_t got = pread(file.fd, bytes + at, n - at, (off_t)at); if (got < 0 && errno == EINTR) continue;
        if (got <= 0) { free(bytes); close(file.fd); return coordinator_error(f, "metadata_read", false); } at += (size_t)got; }
    char actual[65]; recovery_sha(bytes, n, actual); bool ok = strcmp(actual, sha) == 0 && recovery_file_check(&file, f);
    if (ok) { json_raw(j, "{\"kind\":\"metadata_bytes\",\"source\":\"%s\",\"sha256\":\"%s\",\"bytes\":%zu,\"bytesBase64\":", source, sha, n); json_base64(j, bytes, n); json_raw(j, "}"); }
    free(bytes); close(file.fd); return ok ? true : recovery_fail(f, "metadata_changed");
}
bool recovery_metadata(struct recovery *r, const char *source, struct json *j, struct coordinator_failure *f) {
    if (strcmp(source, "components") != 0 && strcmp(source, "settings") != 0) return recovery_fail(f, "metadata_source");
    return recovery_observation_result(r, metadata_observe(r, source, j, f), f);
}
static bool log_path(struct recovery *r, char path[4096], const char *name, struct coordinator_failure *f) {
    int n = snprintf(path, 4096U, "%s/Library/Containers/com.docker.docker/Data/log/vm/%s", r->owner.home, name);
    return n > 0 && n < 4096 ? true : recovery_fail(f, "log_path_bound");
}
static int log_source(const char *name) {
    if (strcmp(name, "init.log") == 0 || strncmp(name, "init.log.", 9U) == 0) return 0;
    if (strcmp(name, "console.log") == 0 || strncmp(name, "console.log.", 12U) == 0) return 1;
    return -1;
}
struct log_identity { dev_t device; ino_t inode; unsigned source; };
static bool log_remember(struct log_identity seen[RECOVERY_LOG_MAX], size_t *count, dev_t device, ino_t inode,
    unsigned source, struct coordinator_failure *f) {
    if (!inode) return recovery_fail(f, "log_census_inode");
    for (size_t i = 0; i < *count; i++) if (seen[i].device == device && seen[i].inode == inode)
        return seen[i].source == source ? true : recovery_fail(f, "log_source_changed");
    if (*count == RECOVERY_LOG_MAX) return recovery_fail(f, "log_identity_bound");
    seen[(*count)++] = (struct log_identity){ device, inode, source }; return true;
}
static bool log_held(const struct recovery *r, dev_t device, ino_t inode, unsigned source) {
    for (size_t i = 0; i < r->log_count; i++) if (r->logs[i].source == source
        && r->logs[i].file.identity.st_dev == device && r->logs[i].file.identity.st_ino == inode) return true;
    return false;
}
static bool log_rescan_wait(struct coordinator_failure *f) {
    uint64_t deadline = recovery_now() + 10U;
    for (unsigned interruption = 0; interruption < 8U; interruption++) {
        uint64_t now = recovery_now(); if (now >= deadline) return true;
        struct timespec delay = { .tv_sec = 0, .tv_nsec = (long)(deadline - now) * 1000000L };
        if (nanosleep(&delay, NULL) == 0) return true;
        if (errno != EINTR) return coordinator_error(f, "log_census_wait", false);
    }
    return recovery_fail(f, "log_census_wait_bound");
}
static bool log_discover(struct recovery *r, bool initial, struct coordinator_failure *f) {
    enum { CENSUS_PASSES = 8 };
    char directory[4096]; if (!log_path(r, directory, "", f)) return false;
    directory[strlen(directory) - 1U] = 0;
    struct log_identity seen[RECOVERY_LOG_MAX]; size_t seen_count = 0; unsigned discovered[2] = {0};
    struct stat original = {0};
    for (unsigned pass = 0; pass < CENSUS_PASSES; pass++) {
        int fd = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (fd < 0) return coordinator_error(f, "log_directory_open", false);
        struct stat before;
        if (fstat(fd, &before) < 0) { close(fd); return coordinator_error(f, "log_directory_stat", false); }
        if (pass == 0) original = before;
        else if (!coordinator_same(&original, &before)) { close(fd); return recovery_fail(f, "log_directory_changed"); }
        DIR *dir = fdopendir(fd); if (!dir) { close(fd); return coordinator_error(f, "log_directory", false); }
        struct dirent *entry; unsigned per_source[2] = {0}; bool changed = false, ok = true; int error = 0;
        for (;;) {
            errno = 0; entry = readdir(dir); if (!entry) { error = errno; break; }
            int source = log_source(entry->d_name); if (source < 0) continue;
            if (++per_source[source] > 32U) { ok = recovery_fail(f, "log_rotation_bound"); break; }
            if (!log_remember(seen, &seen_count, before.st_dev, entry->d_ino, (unsigned)source, f)) { ok = false; break; }
            struct stat s;
            if (fstatat(fd, entry->d_name, &s, AT_SYMLINK_NOFOLLOW) < 0) {
                if (errno == ENOENT) { changed = true; break; }
                ok = coordinator_error(f, "log_census_stat", false); break;
            }
            if (!log_remember(seen, &seen_count, s.st_dev, s.st_ino, (unsigned)source, f)) { ok = false; break; }
            if (s.st_ino != entry->d_ino || s.st_dev != before.st_dev) { changed = true; break; }
            if (log_held(r, s.st_dev, s.st_ino, (unsigned)source)) continue;
            if (r->log_count == RECOVERY_LOG_MAX) { ok = recovery_fail(f, "log_identity_bound"); break; }
            char path[4096]; if (!log_path(r, path, entry->d_name, f)) { ok = false; break; }
            struct log_file candidate = { .file.fd = -1, .source = (unsigned)source };
            if (!recovery_file_open(path, &candidate.file, false, f)) {
                if (f->error == ENOENT) { *f = (struct coordinator_failure){0}; changed = true; break; }
                ok = false; break;
            }
            const struct stat *opened = &candidate.file.identity;
            if (!log_remember(seen, &seen_count, opened->st_dev, opened->st_ino, (unsigned)source, f)) { close(candidate.file.fd); ok = false; break; }
            if (log_held(r, opened->st_dev, opened->st_ino, (unsigned)source)) { close(candidate.file.fd); changed = true; break; }
            if (!initial && ++discovered[source] > 1U) { close(candidate.file.fd); ok = recovery_fail(f, "log_rotation_gap"); break; }
            candidate.initial = initial ? (uint64_t)opened->st_size : 0; candidate.cursor = candidate.initial;
            if (r->queue >= 0) {
                struct kevent event;
                EV_SET(&event, (uintptr_t)candidate.file.fd, EVFILT_VNODE, EV_ADD | EV_CLEAR, NOTE_DELETE | NOTE_RENAME | NOTE_REVOKE | NOTE_WRITE | NOTE_EXTEND, 0, NULL);
                if (kevent(r->queue, &event, 1, NULL, 0, NULL) < 0) { close(candidate.file.fd); ok = coordinator_error(f, "log_watch", false); break; }
            }
            r->logs[r->log_count++] = candidate;
            if (!coordinator_same(opened, &s)) { changed = true; break; }
        }
        struct stat after, named;
        if (ok && error) { errno = error; ok = coordinator_error(f, "log_census", false); }
        if (ok && (fstat(fd, &after) < 0 || lstat(directory, &named) < 0)) ok = coordinator_error(f, "log_directory_stat", false);
        if (ok && (!coordinator_same(&original, &after) || !coordinator_same(&original, &named) || !S_ISDIR(named.st_mode)))
            ok = recovery_fail(f, "log_directory_changed");
        if (ok && (before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec || before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec
            || before.st_ctimespec.tv_sec != after.st_ctimespec.tv_sec || before.st_ctimespec.tv_nsec != after.st_ctimespec.tv_nsec
            || before.st_mtimespec.tv_sec != named.st_mtimespec.tv_sec || before.st_mtimespec.tv_nsec != named.st_mtimespec.tv_nsec
            || before.st_ctimespec.tv_sec != named.st_ctimespec.tv_sec || before.st_ctimespec.tv_nsec != named.st_ctimespec.tv_nsec)) changed = true;
        closedir(dir); if (!ok) return false;
        if (changed) {
            if (pass + 1U < CENSUS_PASSES && !log_rescan_wait(f)) return false;
            continue;
        }
        for (size_t i = 0; i < seen_count; i++) if (!log_held(r, seen[i].device, seen[i].inode, seen[i].source)) return recovery_fail(f, "log_rotation_gap");
        return true;
    }
    return recovery_fail(f, "log_census_bound");
}
bool recovery_logs_arm(struct recovery *r, struct coordinator_failure *f) {
    for (size_t i = 0; i < r->log_count; i++) close(r->logs[i].file.fd);
    r->log_count = 0; r->span_count = 0; r->observed_bytes = 0; r->chunk_sequence = 0;
    if (!log_discover(r, true, f)) return false;
    bool sources[2] = {false};
    for (size_t i = 0; i < r->log_count; i++) sources[r->logs[i].source] = true;
    return sources[0] && sources[1] ? true : recovery_fail(f, "log_source_missing");
}
static bool logs_observe(struct recovery *r, struct coordinator_failure *f) {
    if (!log_discover(r, false, f)) return false;
    for (size_t i = 0; i < r->log_count; i++) {
        struct stat s;
        if (fstat(r->logs[i].file.fd, &s) < 0) return coordinator_error(f, "log_held_stat", false);
        if (!coordinator_same(&s, &r->logs[i].file.identity) || s.st_size < (off_t)r->logs[i].cursor)
            return recovery_fail(f, "log_coverage_lost");
    }
    return true;
}
bool recovery_logs_check(struct recovery *r, struct coordinator_failure *f) {
    return recovery_observation_result(r, logs_observe(r, f), f);
}
bool recovery_logs_finish(struct recovery *r, struct coordinator_failure *f) {
    if (!recovery_logs_check(r, f)) return false;
    for (size_t i = 0; i < r->log_count; i++) {
        struct stat current;
        if (fstat(r->logs[i].file.fd, &current) < 0)
            return recovery_observation_result(r, coordinator_error(f, "log_finish_stat", false), f);
        if ((uint64_t)current.st_size != r->logs[i].cursor) return recovery_fail(f, "unread_log_bytes");
    }
    unsigned char bytes[RECOVERY_CHUNK];
    for (size_t i = 0; i < r->span_count; i++) {
        const struct log_span *span = &r->spans[i]; size_t n = (size_t)(span->end - span->start);
        if (n > sizeof(bytes) || pread(r->logs[span->file].file.fd, bytes, n, (off_t)span->start) != (ssize_t)n)
            return recovery_observation_result(r, recovery_fail(f, "log_span_changed"), f);
        char sha[65]; recovery_sha(bytes, n, sha); if (strcmp(sha, span->sha) != 0)
            return recovery_observation_result(r, recovery_fail(f, "log_span_changed"), f);
    }
    return true;
}
static bool log_read_observe(struct recovery *r, const char *source, unsigned selected, struct json *j, struct coordinator_failure *f) {
    unsigned char bytes[RECOVERY_CHUNK]; size_t length = 0; uint64_t start = 0, end = 0; char identity[128]; bool done = true;
    bool observed = recovery_observing(r);
    size_t selected_file = 0;
    if (!observed) {
        char path[4096]; if (!log_path(r, path, selected == 0 ? "init.log" : "console.log", f)) return false;
        struct file_fact file = { .fd = -1 }; if (!recovery_file_open(path, &file, false, f)) return false;
        end = (uint64_t)file.identity.st_size; start = end > RECOVERY_CHUNK ? end - RECOVERY_CHUNK : 0; length = (size_t)(end - start);
        ssize_t n = pread(file.fd, bytes, length, (off_t)start); struct stat after;
        bool ok = n == (ssize_t)length && fstat(file.fd, &after) == 0 && after.st_size >= (off_t)end && recovery_file_check(&file, f);
        snprintf(identity, sizeof(identity), "%llu:%llu", (unsigned long long)file.identity.st_dev, (unsigned long long)file.identity.st_ino); close(file.fd);
        if (!ok) return recovery_fail(f, "log_baseline_changed");
    } else {
        if (!recovery_events(r, f) || !recovery_logs_check(r, f)) return false;
        bool found = false;
        for (size_t i = 0; i < r->log_count; i++) {
            if (r->logs[i].source != selected) continue;
            struct stat s; if (fstat(r->logs[i].file.fd, &s) < 0) return coordinator_error(f, "log_stat", false);
            if (!found || (r->logs[i].cursor < (uint64_t)s.st_size)) { selected_file = i; found = true;
                if (r->logs[i].cursor < (uint64_t)s.st_size) break; }
        }
        if (!found) return recovery_fail(f, "log_source_missing");
        struct log_file *log = &r->logs[selected_file]; struct stat before;
        if (fstat(log->file.fd, &before) < 0) return coordinator_error(f, "log_stat", false);
        start = log->cursor; end = (uint64_t)before.st_size; if (end - start > RECOVERY_CHUNK) end = start + RECOVERY_CHUNK;
        length = (size_t)(end - start);
        if (length && (r->span_count == RECOVERY_SPAN_MAX || r->observed_bytes > 32U * 1024U * 1024U - length)) return recovery_fail(f, "log_consumption_bound");
        ssize_t n = pread(log->file.fd, bytes, length, (off_t)start);
        if (n != (ssize_t)length) return recovery_fail(f, "log_read_changed");
        log->cursor = end;
        snprintf(identity, sizeof(identity), "%llu:%llu", (unsigned long long)log->file.identity.st_dev, (unsigned long long)log->file.identity.st_ino);
        if (length) { struct log_span *span = &r->spans[r->span_count++]; *span = (struct log_span){ .file = (unsigned)selected_file, .sequence = r->chunk_sequence + 1U, .start = start, .end = end };
            recovery_sha(bytes, length, span->sha); r->observed_bytes += length; }
        for (size_t i = 0; i < r->log_count; i++) if (r->logs[i].source == selected) {
            struct stat s; if (fstat(r->logs[i].file.fd, &s) < 0) return coordinator_error(f, "log_stat", false);
            if (r->logs[i].cursor < (uint64_t)s.st_size) done = false;
        }
    }
    char sha[65]; recovery_sha(bytes, length, sha);
    if (length || !observed) r->chunk_sequence++;
    uint64_t sequence = r->chunk_sequence ? r->chunk_sequence : 1U;
    json_raw(j, "{\"kind\":\"log_bytes\",\"phase\":\"%s\",\"source\":\"%s\",\"sourceIdentity\":\"%s\",\"sequence\":%llu,\"start\":\"%llu\",\"end\":\"%llu\",\"sha256\":\"%s\",\"bytesBase64\":",
        observed ? "observed" : "baseline", source, identity, (unsigned long long)sequence, (unsigned long long)start, (unsigned long long)end, sha);
    json_base64(j, bytes, length); json_raw(j, ",\"done\":%s}", done ? "true" : "false"); return true;
}
bool recovery_log_read(struct recovery *r, const char *source, struct json *j, struct coordinator_failure *f) {
    if (r->pending_fact.body) return recovery_fail(f, "native_publication_pending");
    if (r->phase == OBS_ARMING) return recovery_fail(f, "native_facts_unfinished");
    unsigned selected;
    if (strcmp(source, "init") == 0) selected = 0; else if (strcmp(source, "console") == 0) selected = 1; else return recovery_fail(f, "log_source");
    bool observed = recovery_observing(r);
    bool ok = log_read_observe(r, source, selected, j, f);
    if (ok && !j->valid) ok = recovery_fail(f, "log_response_bound");
    return observed ? recovery_observation_result(r, ok, f) : ok;
}
void recovery_files_close(struct recovery *r) {
    for (size_t i = 0; i < r->log_count; i++) if (r->logs[i].file.fd >= 0) close(r->logs[i].file.fd);
    r->log_count = 0;
    struct file_fact *files[] = { &r->disk, &r->settings, &r->components };
    for (size_t i = 0; i < sizeof(files) / sizeof(files[0]); i++) if (files[i]->fd >= 0) { close(files[i]->fd); files[i]->fd = -1; }
}
