#include "coordinator.h"

#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char frame_magic[] = "AGENAI-SNAPSHOT-1\n";
_Static_assert(sizeof(frame_magic) - 1U + 65U + 65U == COORDINATOR_FRAME_HEADER, "snapshot frame size");

static void hash_hex(const char *bytes, size_t length, char output[65]) {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(bytes, (CC_LONG)length, digest);
    static const char hex[] = "0123456789abcdef";
    for (size_t index = 0; index < sizeof(digest); index++) {
        output[index * 2U] = hex[digest[index] >> 4U];
        output[index * 2U + 1U] = hex[digest[index] & 15U];
    }
    output[64] = '\0';
}

bool coordinator_utf8(const unsigned char *bytes, size_t length) {
    for (size_t index = 0; index < length;) {
        unsigned char first = bytes[index++];
        if (first < 0x80U) continue;
        size_t remaining;
        unsigned int value, minimum;
        if (first >= 0xc2U && first <= 0xdfU) { remaining = 1; value = first & 0x1fU; minimum = 0x80U; }
        else if (first >= 0xe0U && first <= 0xefU) { remaining = 2; value = first & 0x0fU; minimum = 0x800U; }
        else if (first >= 0xf0U && first <= 0xf4U) { remaining = 3; value = first & 0x07U; minimum = 0x10000U; }
        else return false;
        if (remaining > length - index) return false;
        for (size_t part = 0; part < remaining; part++) {
            unsigned char next = bytes[index++];
            if ((next & 0xc0U) != 0x80U) return false;
            value = (value << 6U) | (next & 0x3fU);
        }
        if (value < minimum || value > 0x10ffffU || (value >= 0xd800U && value <= 0xdfffU)) return false;
    }
    return true;
}

bool coordinator_read(struct coordinator *owner, char **payload, size_t *length, char digest[65], struct coordinator_failure *failure) {
    if (!coordinator_check(owner, failure)) return false;
    if (owner->initial_required) { errno = EINPROGRESS; return coordinator_error(failure, "state_uninitialized", false); }
    struct stat before, after;
    if (fstat(owner->state_fd, &before) < 0) return coordinator_error(failure, "state_stat", false);
    if (before.st_size <= (off_t)COORDINATOR_FRAME_HEADER || before.st_size > COORDINATOR_MAX_FRAME)
        return coordinator_conflict(failure, "state_frame_bound");
    size_t size = (size_t)before.st_size;
    char *bytes = malloc(size + 1U);
    if (!bytes) return coordinator_error(failure, "snapshot_allocation", false);
    size_t offset = 0;
    while (offset < size) {
        ssize_t count = pread(owner->state_fd, bytes + offset, size - offset, (off_t)offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) {
            if (count == 0) errno = EIO;
            free(bytes); return coordinator_error(failure, "snapshot_read", false);
        }
        offset += (size_t)count;
    }
    if (fstat(owner->state_fd, &after) < 0) {
        free(bytes); return coordinator_error(failure, "state_stat", false);
    }
    if (!coordinator_same(&before, &after) || before.st_size != after.st_size || !coordinator_check(owner, failure)) {
        free(bytes);
        if (failure->reason) return false;
        return coordinator_conflict(failure, "state_changed");
    }
    size_t magic_length = sizeof(frame_magic) - 1U;
    if (memcmp(bytes, frame_magic, magic_length) != 0 || memcmp(bytes + magic_length, owner->key, 64U) != 0
        || bytes[magic_length + 64U] != '\n' || bytes[COORDINATOR_FRAME_HEADER - 1U] != '\n') {
        free(bytes); return coordinator_conflict(failure, "state_frame_identity");
    }
    *length = size - COORDINATOR_FRAME_HEADER;
    hash_hex(bytes + COORDINATOR_FRAME_HEADER, *length, digest);
    if (memcmp(bytes + magic_length + 65U, digest, 64U) != 0) {
        free(bytes); return coordinator_conflict(failure, "state_checksum");
    }
    if (owner->has_state_digest && strcmp(owner->state_digest, digest) != 0) {
        free(bytes); return coordinator_conflict(failure, "state_content_substituted");
    }
    if (!coordinator_utf8((const unsigned char *)bytes + COORDINATOR_FRAME_HEADER, *length)) {
        free(bytes); return coordinator_conflict(failure, "state_utf8");
    }
    memmove(bytes, bytes + COORDINATOR_FRAME_HEADER, *length);
    bytes[*length] = '\0';
    memcpy(owner->state_digest, digest, 65U);
    owner->has_state_digest = true;
    *payload = bytes;
    return true;
}

static bool write_all(int descriptor, const char *bytes, size_t length, struct coordinator_failure *failure) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t written = write(descriptor, bytes + offset, length - offset);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) {
            if (written == 0) errno = EIO;
            return coordinator_error(failure, "snapshot_write", false);
        }
        offset += (size_t)written;
    }
    return true;
}

bool coordinator_commit(struct coordinator *owner, const char *payload, size_t length, char digest[65], struct coordinator_failure *failure) {
    if (!coordinator_check(owner, failure)) return false;
    if (owner->fenced && !owner->cleanup) { errno = EPERM; return coordinator_error(failure, "storage_fenced", false); }
    if (owner->temp_present) { errno = EEXIST; return coordinator_error(failure, "unpublished_temp", false); }
    if (!owner->initial_required) {
        char *current = NULL, current_digest[65]; size_t current_length;
        if (!coordinator_read(owner, &current, &current_length, current_digest, failure)) return false;
        free(current);
    }
    owner->temp_fd = openat(owner->root_fd, owner->temp_name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (owner->temp_fd < 0) return coordinator_error(failure, "temp_create", false);
    if (fstat(owner->temp_fd, &owner->temp_identity) < 0) return coordinator_error(failure, "temp_stat", true);
    owner->temp_present = true;
    if (!coordinator_private_file(&owner->temp_identity)) return coordinator_conflict(failure, "temp_identity");
    hash_hex(payload, length, digest);
    char header[COORDINATOR_FRAME_HEADER + 1U];
    int written = snprintf(header, sizeof(header), "%s%s\n%s\n", frame_magic, owner->key, digest);
    if (written != (int)COORDINATOR_FRAME_HEADER) return coordinator_conflict(failure, "frame_construction");
    if (!write_all(owner->temp_fd, header, COORDINATOR_FRAME_HEADER, failure)
        || !write_all(owner->temp_fd, payload, length, failure)) return false;
    if (fsync(owner->temp_fd) < 0) return coordinator_error(failure, "temp_sync", false);
    if (!coordinator_check(owner, failure)) return false;
    if (renameat(owner->root_fd, owner->temp_name, owner->root_fd, owner->state_name) < 0)
        return coordinator_error(failure, "state_rename", false);
    int previous = owner->state_fd;
    owner->state_fd = owner->temp_fd;
    owner->state_identity = owner->temp_identity;
    owner->temp_fd = -1;
    owner->temp_present = false;
    owner->initial_required = false;
    memcpy(owner->state_digest, digest, 65U);
    owner->has_state_digest = true;
    close(previous);
    if (fsync(owner->root_fd) < 0) return coordinator_error(failure, "publication_sync", false);
    if (!coordinator_check(owner, failure)) return false;
    char *published = NULL, published_digest[65]; size_t published_length;
    if (!coordinator_read(owner, &published, &published_length, published_digest, failure)) return false;
    bool exact = published_length == length && memcmp(payload, published, length) == 0 && strcmp(digest, published_digest) == 0;
    free(published);
    if (!exact) return coordinator_conflict(failure, "publication_changed");
    return true;
}

bool coordinator_discard_temp(struct coordinator *owner, struct coordinator_failure *failure) {
    if (!owner->cleanup) { errno = EPERM; return coordinator_error(failure, "cleanup_required", false); }
    if (!coordinator_check(owner, failure)) return false;
    if (!owner->temp_present) { errno = ENOENT; return coordinator_error(failure, "temp_missing", false); }
    if (owner->initial_required) { errno = EINPROGRESS; return coordinator_error(failure, "state_uninitialized", false); }
    char *payload = NULL, digest[65]; size_t length;
    if (!coordinator_read(owner, &payload, &length, digest, failure)) return false;
    free(payload);
    if (!coordinator_check(owner, failure)) return false;
    if (unlinkat(owner->root_fd, owner->temp_name, 0) < 0) return coordinator_error(failure, "temp_discard", false);
    if (owner->temp_fd >= 0) close(owner->temp_fd);
    owner->temp_fd = -1;
    owner->temp_present = false;
    if (fsync(owner->root_fd) < 0) return coordinator_error(failure, "temp_discard_sync", false);
    return coordinator_check(owner, failure);
}
