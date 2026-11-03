#include "recovery.h"
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stdio.h>
#include <unistd.h>

#define RECEIPT_HEADER 512U
static bool read_file(int parent, const char *name, size_t max, char **bytes, size_t *n, struct coordinator_failure *f);
static void origin_header(struct recovery *r, struct json *j);
static bool private_directory(const struct stat *s) { return S_ISDIR(s->st_mode) && s->st_uid == getuid() && (s->st_mode & 07777) == 0700; }
static int directory(int parent, const char *name, bool create, struct stat *identity, struct coordinator_failure *f) {
    bool made = false;
    if (create && mkdirat(parent, name, 0700) == 0) made = true;
    else if (create && errno != EEXIST) { coordinator_error(f, "evidence_directory_create", false); return -1; }
    int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) { coordinator_error(f, "evidence_directory_open", false); return -1; }
    struct stat named;
    if (fstat(fd, identity) < 0 || fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) < 0
        || !private_directory(identity) || !coordinator_same(identity, &named)) {
        close(fd); recovery_fail(f, "evidence_directory_identity"); return -1;
    }
    if (made && (fsync(fd) < 0 || fsync(parent) < 0)) { close(fd); coordinator_error(f, "evidence_directory_sync", false); return -1; }
    return fd;
}
static bool named_directory(int parent, const char *name, int fd, const struct stat *identity, struct coordinator_failure *f) {
    struct stat named, current;
    if (fstat(fd, &current) < 0 || fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) < 0)
        return coordinator_error(f, "evidence_directory_stat", false);
    if (!private_directory(&current) || !private_directory(&named)
        || !coordinator_same(&current, identity) || !coordinator_same(&named, identity))
        return coordinator_conflict(f, "evidence_directory_substituted");
    return true;
}
bool recovery_store_check(struct recovery *r, struct coordinator_failure *f) {
    if (!coordinator_check(&r->owner, f)) return false;
    if (!r->bound) return recovery_fail(f, "generation_unbound");
    char name[96]; snprintf(name, sizeof(name), "%s.recovery-evidence-v1", r->owner.key);
    if (!named_directory(r->owner.root_fd, name, r->namespace_fd, &r->namespace_identity, f)
        || !named_directory(r->namespace_fd, r->authority, r->authority_fd, &r->authority_identity, f)
        || !named_directory(r->authority_fd, r->generation, r->generation_fd, &r->generation_identity, f)) return false;
    if (r->attempt_fd >= 0) {
        snprintf(name, sizeof(name), "a%016llx", (unsigned long long)r->attempt);
        if (!named_directory(r->generation_fd, name, r->attempt_fd, &r->attempt_identity, f)) return false;
    }
    if (r->origin_ready) {
        char *header = NULL, *archive = NULL; size_t hn, an; struct json expected; json_init(&expected); origin_header(r, &expected);
        if (!read_file(r->generation_fd, "admission.json", RECOVERY_RECEIPT_MAX, &header, &hn, f)) { json_free(&expected); return false; }
        bool exact = expected.valid && hn == expected.length && memcmp(header, expected.data, hn) == 0;
        free(header); json_free(&expected); if (!exact) return recovery_fail(f, "origin_header_changed");
        if (!read_file(r->generation_fd, "origin.snapshot", COORDINATOR_MAX_FRAME, &archive, &an, f)) return false;
        char sha[65]; recovery_sha(archive, an, sha); free(archive);
        if (strcmp(sha, r->origin_frame) != 0) return recovery_fail(f, "origin_archive_changed");
    }
    return true;
}
static bool full_write(int fd, const char *bytes, size_t n, struct coordinator_failure *f) {
    size_t at = 0;
    while (at < n) { ssize_t count = pwrite(fd, bytes + at, n - at, (off_t)at); if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return coordinator_error(f, "receipt_write", false); at += (size_t)count; }
    return true;
}
static bool read_file(int parent, const char *name, size_t max, char **bytes, size_t *n, struct coordinator_failure *f) {
    int fd = openat(parent, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return coordinator_error(f, "receipt_open", false);
    struct stat before, after, named;
    bool ok = fstat(fd, &before) == 0 && fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) == 0;
    if (!ok) { close(fd); return coordinator_error(f, "receipt_stat", false); }
    if (!coordinator_private_file(&before) || !coordinator_same(&before, &named) || before.st_size <= 0 || before.st_size > (off_t)max) {
        close(fd); return recovery_fail(f, "receipt_identity");
    }
    char *data = malloc((size_t)before.st_size + 1U); if (!data) { close(fd); return coordinator_error(f, "receipt_allocation", false); }
    size_t at = 0;
    while (at < (size_t)before.st_size) { ssize_t got = pread(fd, data + at, (size_t)before.st_size - at, (off_t)at);
        if (got < 0 && errno == EINTR) continue; if (got <= 0) { free(data); close(fd); return coordinator_error(f, "receipt_read", false); } at += (size_t)got; }
    ok = fstat(fd, &after) == 0 && fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) == 0;
    close(fd);
    if (!ok || !coordinator_private_file(&after) || !coordinator_private_file(&named)
        || !coordinator_same(&before, &after) || !coordinator_same(&before, &named) || before.st_size != after.st_size
        || before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec || before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec) {
        free(data); return recovery_fail(f, "receipt_changed");
    }
    data[at] = 0; *bytes = data; *n = at; return true;
}
static bool reserve(int parent, const char *name, size_t max, struct coordinator_failure *f) {
    char work[128]; snprintf(work, sizeof(work), ".%s.work", name);
    int fd = openat(parent, work, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0600);
    if (fd < 0 && errno == EEXIST) fd = openat(parent, work, O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return coordinator_error(f, "receipt_reserve_open", false);
    struct stat s, named;
    bool ok = fstat(fd, &s) == 0 && fstatat(parent, work, &named, AT_SYMLINK_NOFOLLOW) == 0;
    if (!ok || !coordinator_private_file(&s) || !coordinator_same(&s, &named) || s.st_size > (off_t)max) {
        close(fd); return recovery_fail(f, "receipt_reserve_identity");
    }
    fstore_t allocation = { .fst_flags = F_ALLOCATEALL, .fst_posmode = F_PEOFPOSMODE, .fst_offset = 0, .fst_length = (off_t)max };
    if (((uint64_t)s.st_blocks * 512U < max && fcntl(fd, F_PREALLOCATE, &allocation) < 0) || fsync(fd) < 0 || fsync(parent) < 0) {
        close(fd); return coordinator_error(f, "receipt_reserve", false);
    }
    close(fd); return true;
}
static bool publish_bytes(struct recovery *r, int parent, const char *name, const char *bytes, size_t n, size_t max, struct coordinator_failure *f) {
    if (!recovery_store_check(r, f)) return false;
    struct stat existing;
    if (fstatat(parent, name, &existing, AT_SYMLINK_NOFOLLOW) == 0) {
        char *actual = NULL; size_t length = 0;
        if (!read_file(parent, name, max, &actual, &length, f)) return false;
        bool same = length == n && memcmp(actual, bytes, n) == 0; free(actual);
        if (!same) return recovery_fail(f, "receipt_conflict");
        if (fsync(parent) < 0) return coordinator_error(f, "receipt_join_sync", false);
        return recovery_store_check(r, f);
    }
    if (errno != ENOENT) return coordinator_error(f, "receipt_stat", false);
    if (!reserve(parent, name, max, f)) return false;
    char work[128]; snprintf(work, sizeof(work), ".%s.work", name);
    int fd = openat(parent, work, O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return coordinator_error(f, "receipt_work_open", false);
    struct stat opened, named;
    if (fstat(fd, &opened) < 0 || fstatat(parent, work, &named, AT_SYMLINK_NOFOLLOW) < 0
        || !coordinator_private_file(&opened) || !coordinator_same(&opened, &named)) {
        close(fd); return recovery_fail(f, "receipt_work_identity");
    }
    bool ok = full_write(fd, bytes, n, f) && ftruncate(fd, (off_t)n) == 0 && fsync(fd) == 0;
    if (!ok) { close(fd); if (!f->reason) coordinator_error(f, "receipt_work_sync", false); return false; }
    char sha[65], expected[65]; recovery_sha(bytes, n, expected);
    if (!recovery_hash_fd(fd, (off_t)max, sha, f) || strcmp(sha, expected) != 0 || !recovery_store_check(r, f)) { close(fd); return false; }
    if (fstatat(parent, work, &named, AT_SYMLINK_NOFOLLOW) < 0 || !coordinator_same(&opened, &named)) {
        close(fd); return recovery_fail(f, "receipt_work_substituted");
    }
    if (renameatx_np(parent, work, parent, name, RENAME_EXCL) < 0) { close(fd); return coordinator_error(f, "receipt_publish", false); }
    if (fsync(parent) < 0) { close(fd); return coordinator_error(f, "receipt_publication_sync", false); }
    if (fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) < 0 || !coordinator_same(&opened, &named)) {
        close(fd); return recovery_fail(f, "receipt_publication_identity");
    }
    close(fd);
    char *actual = NULL; size_t length;
    if (!read_file(parent, name, max, &actual, &length, f)) return false;
    ok = length == n && memcmp(actual, bytes, n) == 0; free(actual);
    return ok ? recovery_store_check(r, f) : recovery_fail(f, "receipt_publication_changed");
}
static bool receipt_header(struct recovery *r, const char *kind, const char *scope, const char *body, size_t length, char header[RECEIPT_HEADER], struct coordinator_failure *f) {
    char payload_sha[65]; recovery_sha(body, length, payload_sha); memset(header, 0, RECEIPT_HEADER);
    int n = snprintf(header, RECEIPT_HEADER, "AGENAI-RECOVERY-1\n%s\n%s\n%s\n%s\n%zu\n%s\n", r->owner.key, r->recovery_key, kind, scope, length, payload_sha);
    return n > 0 && n < (int)RECEIPT_HEADER ? true : recovery_fail(f, "receipt_header_bound");
}
static bool slot(struct recovery *r, const char *kind, const char *scope, int *parent, char name[128], bool native, struct coordinator_failure *f) {
    if (!recovery_store_check(r, f)) return false;
    uint64_t attempt;
    if (strcmp(kind, "admission") == 0 || strcmp(kind, "armed") == 0 || strcmp(kind, "stopped") == 0 || strcmp(kind, "finished") == 0 || strcmp(kind, "outcome") == 0 || strcmp(kind, "barrier_acceptance") == 0) {
        if (!recovery_decimal(scope, &attempt, true)) return recovery_fail(f, "receipt_scope");
        if (native && attempt != r->attempt) return recovery_fail(f, "receipt_attempt_binding");
        char dirname[32]; snprintf(dirname, sizeof(dirname), "a%016llx", (unsigned long long)attempt);
        struct stat ignored; *parent = directory(r->generation_fd, dirname, false, &ignored, f);
        if (*parent < 0) return false;
        snprintf(name, 128U, "%s.json", kind); return true;
    }
    *parent = dup(r->generation_fd); if (*parent < 0) return coordinator_error(f, "evidence_duplicate", false);
    if (strcmp(kind, "member_terminal") == 0 && recovery_uuid(scope)) snprintf(name, 128U, "m%s.terminal.json", scope);
    else if (strcmp(scope, "generation") != 0) { close(*parent); return recovery_fail(f, "receipt_scope"); }
    else if (strcmp(kind, "final_inventory") == 0) strcpy(name, "final-inventory.json");
    else if (strcmp(kind, "generation_terminal") == 0) strcpy(name, "generation-terminal.json");
    else if (strcmp(kind, "origin_archive") == 0) strcpy(name, "origin.snapshot");
    else if (strcmp(kind, "terminal_archive") == 0) strcpy(name, "terminal.snapshot");
    else { close(*parent); return recovery_fail(f, "receipt_kind"); }
    return true;
}
static void receipt_reply(struct json *j, const char *kind, const char *scope, const char *frame, size_t n, const char *body, size_t length) {
    char digest[65]; recovery_sha(frame, n, digest);
    json_raw(j, "{\"kind\":\"receipt\",\"recordKind\":\"%s\",\"scope\":\"%s\",\"digest\":\"%s\",\"bytes\":%zu,\"text\":", kind, scope, digest, n);
    json_string(j, body, length); json_raw(j, "}");
}
bool recovery_publish(struct recovery *r, const char *kind, const char *scope, const char *body, size_t length, struct json *j, char digest[65], struct coordinator_failure *f) {
    if (length == 0 || length > RECOVERY_RECEIPT_MAX - RECEIPT_HEADER || !coordinator_utf8((const unsigned char *)body, length)) return recovery_fail(f, "receipt_payload");
    int parent; char name[128]; if (!slot(r, kind, scope, &parent, name, true, f)) return false;
    size_t n = RECEIPT_HEADER + length; char *frame = malloc(n);
    if (!frame) { close(parent); return coordinator_error(f, "receipt_allocation", false); }
    bool ok = receipt_header(r, kind, scope, body, length, frame, f); memcpy(frame + RECEIPT_HEADER, body, length);
    if (ok && digest) recovery_sha(frame, n, digest);
    if (ok) ok = publish_bytes(r, parent, name, frame, n, RECOVERY_RECEIPT_MAX, f);
    if (ok) receipt_reply(j, kind, scope, frame, n, body, length);
    free(frame); close(parent); return ok;
}
bool recovery_sdk_decision(struct recovery *r, const char *kind, const char *scope, const char *body, size_t length, struct json *j, struct coordinator_failure *f) {
    if (!r->origin_ready) return recovery_fail(f, "generation_unbound");
    if (strcmp(kind, "barrier_acceptance") != 0 && strcmp(kind, "member_terminal") != 0
        && strcmp(kind, "final_inventory") != 0 && strcmp(kind, "generation_terminal") != 0) return recovery_fail(f, "sdk_decision_kind");
    if (strcmp(kind, "barrier_acceptance") == 0) {
        if (r->phase != OBS_FINISHED) return recovery_fail(f, "native_facts_unfinished");
        uint64_t attempt;
        if (!recovery_decimal(scope, &attempt, true) || attempt != r->attempt) return recovery_fail(f, "receipt_attempt_binding");
        struct stat existing;
        if (fstatat(r->attempt_fd, "barrier_acceptance.json", &existing, AT_SYMLINK_NOFOLLOW) < 0) {
            if (errno != ENOENT) return coordinator_error(f, "receipt_stat", false);
            if (r->pending_fact.body) return recovery_fail(f, "native_publication_pending");
            if (r->observation_failure.reason) { *f = r->observation_failure; return false; }
            if (recovery_now() - r->armed_at > RECOVERY_ATTEMPT_MS) return recovery_fail(f, "observation_expired");
        }
    }
    return recovery_publish(r, kind, scope, body, length, j, NULL, f);
}
bool recovery_read_receipt(struct recovery *r, const char *kind, const char *scope, struct json *j, struct coordinator_failure *f) {
    if (!r->origin_ready) return recovery_fail(f, "generation_unbound");
    int parent; char name[128];
    if (!slot(r, kind, scope, &parent, name, false, f)) {
        if (f->error == ENOENT && strcmp(f->reason, "evidence_directory_open") == 0) { *f = (struct coordinator_failure){0}; json_raw(j, "{\"kind\":\"absent\"}"); return true; }
        return false;
    }
    char *bytes = NULL; size_t n;
    bool archive = strcmp(kind, "origin_archive") == 0 || strcmp(kind, "terminal_archive") == 0;
    if (!read_file(parent, name, archive ? COORDINATOR_MAX_FRAME : RECOVERY_RECEIPT_MAX, &bytes, &n, f)) {
        close(parent); if (f->error == ENOENT && strcmp(f->reason, "receipt_open") == 0) { *f = (struct coordinator_failure){0}; json_raw(j, "{\"kind\":\"absent\"}"); return true; } return false;
    }
    size_t header_size = archive ? COORDINATOR_FRAME_HEADER : RECEIPT_HEADER;
    bool valid = n > header_size && coordinator_utf8((unsigned char *)bytes + header_size, n - header_size);
    if (valid && archive) {
        char sha[65]; recovery_sha(bytes + header_size, n - header_size, sha);
        char expected[COORDINATOR_FRAME_HEADER + 1U]; snprintf(expected, sizeof(expected), "AGENAI-SNAPSHOT-1\n%s\n%s\n", r->owner.key, sha);
        valid = memcmp(expected, bytes, header_size) == 0;
    } else if (valid) {
        char expected[RECEIPT_HEADER]; valid = receipt_header(r, kind, scope, bytes + header_size, n - header_size, expected, f) && memcmp(expected, bytes, header_size) == 0;
    }
    if (valid && fsync(parent) < 0) { free(bytes); close(parent); return coordinator_error(f, "receipt_discovery_sync", false); }
    if (valid) valid = recovery_store_check(r, f);
    if (valid) receipt_reply(j, kind, scope, bytes, n, bytes + header_size, n - header_size);
    free(bytes); close(parent); return valid ? true : recovery_fail(f, "receipt_frame");
}
static bool canonical_expected(struct recovery *r, const char *expected, char **body, size_t *length, struct coordinator_failure *f) {
    char sha[65];
    if (!recovery_hex(expected) || !coordinator_read(&r->owner, body, length, sha, f)) return false;
    if (strcmp(expected, sha) != 0) { free(*body); *body = NULL; return recovery_fail(f, "canonical_binding"); }
    return true;
}
static bool namespace_open(struct recovery *r, const char *authority, const char *generation, bool create, struct coordinator_failure *f) {
    if (r->bound) {
        if (strcmp(authority, r->authority) != 0 || strcmp(generation, r->generation) != 0)
            return recovery_fail(f, "generation_binding_conflict");
        return recovery_store_check(r, f);
    }
    char name[96]; snprintf(name, sizeof(name), "%s.recovery-evidence-v1", r->owner.key);
    struct stat namespace_identity, authority_identity, generation_identity;
    int namespace_fd = directory(r->owner.root_fd, name, create, &namespace_identity, f);
    if (namespace_fd < 0) return false;
    int authority_fd = directory(namespace_fd, authority, create, &authority_identity, f);
    if (authority_fd < 0) { close(namespace_fd); return false; }
    int generation_fd = directory(authority_fd, generation, create, &generation_identity, f);
    if (generation_fd < 0) { close(authority_fd); close(namespace_fd); return false; }
    r->namespace_fd = namespace_fd; r->namespace_identity = namespace_identity;
    r->authority_fd = authority_fd; r->authority_identity = authority_identity;
    r->generation_fd = generation_fd; r->generation_identity = generation_identity;
    strcpy(r->authority, authority); strcpy(r->generation, generation); r->bound = true;
    return true;
}
static void binding_reply(struct recovery *r, struct json *j) {
    json_raw(j, "{\"kind\":\"bound_existing\",\"recoveryKey\":\"%s\",\"originFrameDigest\":\"%s\",\"originRawDigest\":\"%s\"}", r->recovery_key, r->origin_frame, r->origin_raw);
}
static void origin_header(struct recovery *r, struct json *j) {
    json_raw(j, "AGENAI-RECOVERY-ORIGIN-1\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%llu\n%llu\n%llu\n%llu\n",
        r->owner.key, r->authority, r->generation, r->recovery_key, r->origin_frame, r->origin_raw, "original-claim-v1",
        (unsigned long long)r->owner.root_identity.st_dev, (unsigned long long)r->owner.root_identity.st_ino,
        (unsigned long long)r->owner.lock_identity.st_dev, (unsigned long long)r->owner.lock_identity.st_ino);
}
bool recovery_archive(struct recovery *r, const char *which, struct json *j, struct coordinator_failure *f) {
    const char *kind, *name;
    if (strcmp(which, "origin") == 0) { kind = "origin_archive"; name = "origin.snapshot"; }
    else if (strcmp(which, "terminal") == 0) { kind = "terminal_archive"; name = "terminal.snapshot"; }
    else return recovery_fail(f, "archive_kind");
    char *body = NULL, sha[65]; size_t length;
    if (!coordinator_read(&r->owner, &body, &length, sha, f)) return false;
    size_t n = COORDINATOR_FRAME_HEADER + length; char *frame = malloc(n + 1U);
    if (!frame) { free(body); return coordinator_error(f, "archive_allocation", false); }
    snprintf(frame, COORDINATOR_FRAME_HEADER + 1U, "AGENAI-SNAPSHOT-1\n%s\n%s\n", r->owner.key, sha);
    memcpy(frame + COORDINATOR_FRAME_HEADER, body, length);
    char full_sha[65]; recovery_sha(frame, n, full_sha);
    bool ok = strcmp(which, "origin") != 0 || (strcmp(full_sha, r->origin_frame) == 0 && strcmp(sha, r->origin_raw) == 0);
    if (!ok) recovery_fail(f, "origin_archive_binding");
    if (ok) ok = publish_bytes(r, r->generation_fd, name, frame, n, COORDINATOR_MAX_FRAME, f);
    if (ok) receipt_reply(j, kind, "generation", frame, n, body, length);
    free(body); free(frame); return ok;
}
bool recovery_bind_origin(struct recovery *r, char **a, struct json *j, struct coordinator_failure *f) {
    if (!recovery_uuid(a[0]) || !recovery_uuid(a[1]) || !recovery_hex(a[2]) || !recovery_hex(a[3])) return recovery_fail(f, "origin_arguments");
    char *body = NULL; size_t length;
    if (!canonical_expected(r, a[4], &body, &length, f)) return false;
    char frame_header[COORDINATOR_FRAME_HEADER + 1U]; snprintf(frame_header, sizeof(frame_header), "AGENAI-SNAPSHOT-1\n%s\n%s\n", r->owner.key, a[4]);
    char *frame = malloc(COORDINATOR_FRAME_HEADER + length); if (!frame) { free(body); return coordinator_error(f, "origin_allocation", false); }
    memcpy(frame, frame_header, COORDINATOR_FRAME_HEADER); memcpy(frame + COORDINATOR_FRAME_HEADER, body, length);
    char digest[65]; recovery_sha(frame, COORDINATOR_FRAME_HEADER + length, digest); free(body); free(frame);
    if (strcmp(digest, a[3]) != 0) return recovery_fail(f, "origin_frame_binding");
    char *existing_args[] = { a[0], a[1], a[4] };
    struct json existing; json_init(&existing);
    bool found = recovery_bind_existing(r, existing_args, &existing, f); json_free(&existing);
    if (!found) return false;
    if (r->origin_ready) {
        if (strcmp(r->recovery_key, a[2]) != 0 || strcmp(r->origin_frame, a[3]) != 0 || strcmp(r->origin_raw, a[4]) != 0)
            return recovery_fail(f, "origin_binding_conflict");
        bool ok = reserve(r->generation_fd, "terminal.snapshot", COORDINATOR_MAX_FRAME, f)
            && reserve(r->generation_fd, "generation-terminal.json", RECOVERY_RECEIPT_MAX, f)
            && reserve(r->generation_fd, "final-inventory.json", RECOVERY_RECEIPT_MAX, f)
            && recovery_store_check(r, f);
        if (ok) binding_reply(r, j);
        return ok;
    }
    if (!namespace_open(r, a[0], a[1], true, f)) return false;
    strcpy(r->recovery_key, a[2]); strcpy(r->origin_frame, a[3]); strcpy(r->origin_raw, a[4]);
    struct json archive, header; json_init(&archive); json_init(&header);
    bool ok = recovery_archive(r, "origin", &archive, f); json_free(&archive);
    if (ok) { origin_header(r, &header); ok = header.valid && publish_bytes(r, r->generation_fd, "admission.json", header.data, header.length, RECOVERY_RECEIPT_MAX, f); }
    json_free(&header);
    if (ok) ok = reserve(r->generation_fd, "terminal.snapshot", COORDINATOR_MAX_FRAME, f)
        && reserve(r->generation_fd, "generation-terminal.json", RECOVERY_RECEIPT_MAX, f)
        && reserve(r->generation_fd, "final-inventory.json", RECOVERY_RECEIPT_MAX, f);
    if (ok) { r->origin_ready = true; ok = recovery_store_check(r, f); }
    if (ok) binding_reply(r, j); return ok;
}
bool recovery_bind_existing(struct recovery *r, char **a, struct json *j, struct coordinator_failure *f) {
    if (!recovery_uuid(a[0]) || !recovery_uuid(a[1])) return recovery_fail(f, "existing_arguments");
    char *body = NULL; size_t length;
    if (!canonical_expected(r, a[2], &body, &length, f)) return false; free(body);
    if (!namespace_open(r, a[0], a[1], false, f)) {
        if (f->error == ENOENT) {
            if (r->generation_fd >= 0) return false;
            if (r->authority_fd >= 0) { close(r->authority_fd); r->authority_fd = -1; }
            if (r->namespace_fd >= 0) { close(r->namespace_fd); r->namespace_fd = -1; }
            *f = (struct coordinator_failure){0}; json_raw(j, "{\"kind\":\"absent\"}"); return true;
        }
        return false;
    }
    char *header = NULL; size_t n;
    if (!read_file(r->generation_fd, "admission.json", RECOVERY_RECEIPT_MAX, &header, &n, f)) return false;
    char key[65], authority[37], generation[37], recovery[65], framed[65], raw[65]; unsigned long long rd, ri, ld, li; int consumed = 0;
    int fields = sscanf(header, "AGENAI-RECOVERY-ORIGIN-1\n%64[a-f0-9]\n%36[a-f0-9-]\n%36[a-f0-9-]\n%64[a-f0-9]\n%64[a-f0-9]\n%64[a-f0-9]\noriginal-claim-v1\n%llu\n%llu\n%llu\n%llu\n%n",
        key, authority, generation, recovery, framed, raw, &rd, &ri, &ld, &li, &consumed);
    bool ok = fields == 10 && (size_t)consumed == n && recovery_hex(recovery) && recovery_hex(framed) && recovery_hex(raw)
        && strcmp(key, r->owner.key) == 0 && strcmp(authority, r->authority) == 0 && strcmp(generation, r->generation) == 0
        && rd == (unsigned long long)r->owner.root_identity.st_dev && ri == (unsigned long long)r->owner.root_identity.st_ino
        && ld == (unsigned long long)r->owner.lock_identity.st_dev && li == (unsigned long long)r->owner.lock_identity.st_ino;
    if (ok) { strcpy(r->recovery_key, recovery); strcpy(r->origin_frame, framed); strcpy(r->origin_raw, raw);
        struct json expected; json_init(&expected); origin_header(r, &expected); ok = expected.valid && expected.length == n && memcmp(expected.data, header, n) == 0; json_free(&expected); }
    free(header); if (!ok) return recovery_fail(f, "origin_header_binding");
    char *archive = NULL; size_t archive_n;
    if (!read_file(r->generation_fd, "origin.snapshot", COORDINATOR_MAX_FRAME, &archive, &archive_n, f)) return false;
    char sha[65], raw_sha[65]; recovery_sha(archive, archive_n, sha);
    ok = archive_n > COORDINATOR_FRAME_HEADER;
    if (ok) recovery_sha(archive + COORDINATOR_FRAME_HEADER, archive_n - COORDINATOR_FRAME_HEADER, raw_sha);
    char expected_header[COORDINATOR_FRAME_HEADER + 1U]; snprintf(expected_header, sizeof(expected_header), "AGENAI-SNAPSHOT-1\n%s\n%s\n", r->owner.key, r->origin_raw);
    ok = ok && strcmp(sha, r->origin_frame) == 0 && strcmp(raw_sha, r->origin_raw) == 0
        && memcmp(archive, expected_header, COORDINATOR_FRAME_HEADER) == 0
        && coordinator_utf8((unsigned char *)archive + COORDINATOR_FRAME_HEADER, archive_n - COORDINATOR_FRAME_HEADER);
    free(archive); if (!ok) return recovery_fail(f, "origin_archive_binding");
    r->origin_ready = true;
    if (fsync(r->generation_fd) < 0 || !recovery_store_check(r, f)) return coordinator_error(f, "origin_discovery_sync", false);
    binding_reply(r, j); return true;
}
bool recovery_bind_attempt(struct recovery *r, char **a, struct json *j, struct coordinator_failure *f) {
    uint64_t attempt, previous;
    if (!r->origin_ready || strcmp(a[0], r->authority) != 0 || strcmp(a[1], r->generation) != 0
        || strcmp(a[2], r->recovery_key) != 0 || strcmp(a[4], r->origin_frame) != 0
        || !recovery_decimal(a[3], &attempt, true) || !recovery_decimal(a[7], &previous, false) || !recovery_hex(a[8])) return recovery_fail(f, "attempt_arguments");
    bool first = strcmp(a[6], "none") == 0 && previous == 0 && strcmp(a[8], "0000000000000000000000000000000000000000000000000000000000000000") == 0;
    bool later = (strcmp(a[6], "outcome") == 0 || strcmp(a[6], "barrier_acceptance") == 0) && previous > 0 && previous < attempt;
    if (!first && !later) return recovery_fail(f, "attempt_history");
    if (recovery_observing(r)) return recovery_fail(f, "observation_active");
    if (r->pending_fact.body) return recovery_fail(f, "native_publication_pending");
    char *body = NULL; size_t n; if (!canonical_expected(r, a[5], &body, &n, f)) return false; free(body);
    if (r->attempt_fd >= 0) close(r->attempt_fd);
    if (r->queue >= 0) { close(r->queue); r->queue = -1; }
    for (size_t i = 0; i < r->log_count; i++) close(r->logs[i].file.fd);
    r->log_count = 0; r->process_count = 0;
    r->attempt = attempt; r->previous_attempt = previous; strcpy(r->previous_kind, a[6]); strcpy(r->previous_digest, a[8]);
    char name[32]; snprintf(name, sizeof(name), "a%016llx", (unsigned long long)attempt);
    r->attempt_fd = directory(r->generation_fd, name, true, &r->attempt_identity, f);
    if (r->attempt_fd < 0) return false;
    r->phase = OBS_IDLE; r->armed_at = recovery_now(); r->last_kind[0] = 0; r->span_count = 0; r->observed_bytes = 0;
    r->observation_failure = (struct coordinator_failure){0};
    json_raw(j, "{\"kind\":\"bound\"}"); return true;
}
bool recovery_reserve_attempt(struct recovery *r, struct coordinator_failure *f) {
    if (!recovery_store_check(r, f) || r->attempt_fd < 0) return recovery_fail(f, "attempt_unbound");
    static const char *names[] = { "admission.json", "armed.json", "stopped.json", "finished.json", "outcome.json", "barrier_acceptance.json" };
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) if (!reserve(r->attempt_fd, names[i], RECOVERY_RECEIPT_MAX, f)) return false;
    return true;
}
