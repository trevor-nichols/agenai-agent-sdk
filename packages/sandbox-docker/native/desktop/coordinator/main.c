#include "coordinator.h"

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#if !defined(__APPLE__) || !defined(__aarch64__)
#error "The Desktop coordinator holder requires native Darwin arm64."
#endif

static void failure_reply(struct coordinator *owner, const struct coordinator_failure *failure) {
    bool lost = failure->lost || !owner->claimed;
    if (lost) coordinator_close(owner);
    else owner->fenced = true;
    printf("{\"kind\":\"failure\",\"reason\":\"%s\",\"errno\":%d,\"claim\":\"%s\"}\n",
        failure->reason, failure->error, lost ? "lost" : "held");
}

static void state_identity(const struct coordinator *owner) {
    printf("\"stateDevice\":\"%llu\",\"stateInode\":\"%llu\"",
        (unsigned long long)owner->state_identity.st_dev, (unsigned long long)owner->state_identity.st_ino);
}

static void opened(const struct coordinator *owner) {
    printf("{\"kind\":\"opened\",\"initial\":\"%s\",\"rootDevice\":\"%llu\",\"rootInode\":\"%llu\","
        "\"lockDevice\":\"%llu\",\"lockInode\":\"%llu\",",
        owner->initial_required ? "required" : "existing",
        (unsigned long long)owner->root_identity.st_dev, (unsigned long long)owner->root_identity.st_ino,
        (unsigned long long)owner->lock_identity.st_dev, (unsigned long long)owner->lock_identity.st_ino);
    state_identity(owner);
    printf(",\"pendingTemp\":%s}\n", owner->temp_present ? "true" : "false");
}

static void json_text(const char *bytes, size_t length) {
    putchar('"');
    for (size_t index = 0; index < length; index++) {
        unsigned char value = (unsigned char)bytes[index];
        if (value == '\\' || value == '"') { putchar('\\'); putchar(value); }
        else if (value < 0x20U) printf("\\u%04x", (unsigned int)value);
        else putchar(value);
    }
    putchar('"');
}

static bool command_line(char command[64], struct coordinator_failure *failure) {
    size_t length = 0;
    for (;;) {
        int next = getchar();
        if (next == EOF) {
            if (length == 0 && !ferror(stdin)) return false;
            errno = EIO; coordinator_error(failure, "command_truncated", true); return false;
        }
        if (next == '\n') { command[length] = '\0'; return true; }
        if (next < 0x20 || next > 0x7e || length >= 63U) {
            errno = EINVAL; coordinator_error(failure, "command_invalid", true); return false;
        }
        command[length++] = (char)next;
    }
}

static bool payload_size(const char *command, size_t *size) {
    if (strncmp(command, "COMMIT ", 7U) != 0 || command[7] < '1' || command[7] > '9') return false;
    size_t result = 0;
    for (const char *next = command + 7; *next; next++) {
        if (*next < '0' || *next > '9') return false;
        result = result * 10U + (size_t)(*next - '0');
        if (result > COORDINATOR_MAX_PAYLOAD) return false;
    }
    *size = result;
    return true;
}

static bool read_payload(char *bytes, size_t length, struct coordinator_failure *failure) {
    size_t offset = 0;
    while (offset < length) {
        size_t count = fread(bytes + offset, 1U, length - offset, stdin);
        if (count == 0) { errno = EIO; return coordinator_error(failure, "payload_truncated", true); }
        offset += count;
    }
    if (getchar() != '\n') { errno = EINVAL; return coordinator_error(failure, "payload_terminator", true); }
    if (!coordinator_utf8((const unsigned char *)bytes, length)) {
        errno = EILSEQ; return coordinator_error(failure, "payload_utf8", true);
    }
    return true;
}

static bool dispatch(struct coordinator *owner, const char *command, struct coordinator_failure *failure) {
    if (strcmp(command, "READ") == 0) {
        char *payload = NULL, digest[65]; size_t length;
        if (!coordinator_read(owner, &payload, &length, digest, failure)) return false;
        printf("{\"kind\":\"snapshot\",\"digest\":\"%s\",", digest);
        state_identity(owner);
        printf(",\"pendingTemp\":%s,\"text\":", owner->temp_present ? "true" : "false");
        json_text(payload, length); puts("}"); free(payload);
        return true;
    }
    if (strcmp(command, "CHECK") == 0) {
        if (!coordinator_check(owner, failure)) return false;
        printf("{\"kind\":\"checked\",\"fenced\":%s}\n", owner->fenced ? "true" : "false");
        return true;
    }
    if (strcmp(command, "CLEANUP") == 0) {
        if (!coordinator_check(owner, failure)) return false;
        owner->cleanup = true; puts("{\"kind\":\"cleanup\"}"); return true;
    }
    if (strcmp(command, "DISCARD_TEMP") == 0) {
        if (!coordinator_discard_temp(owner, failure)) return false;
        puts("{\"kind\":\"discarded\"}"); return true;
    }
    size_t length;
    if (!payload_size(command, &length)) { errno = EINVAL; return coordinator_error(failure, "command_invalid", true); }
    char *payload = malloc(length);
    if (!payload) { errno = ENOMEM; return coordinator_error(failure, "payload_allocation", true); }
    char digest[65];
    bool valid = read_payload(payload, length, failure) && coordinator_commit(owner, payload, length, digest, failure);
    free(payload);
    if (!valid) return false;
    printf("{\"kind\":\"committed\",\"digest\":\"%s\",", digest);
    state_identity(owner); puts("}");
    return true;
}

int main(int argc, char **argv) {
    struct coordinator owner = { .root_fd = -1, .lock_fd = -1, .state_fd = -1, .temp_fd = -1 };
    struct coordinator_failure failure = {0};
    signal(SIGPIPE, SIG_IGN);
    umask(0077);
    enum coordinator_mode mode = MODE_OPEN;
    if (getuid() != geteuid() || getgid() != getegid()
        || argc != 3 || strlen(argv[2]) != 64U || strspn(argv[2], "0123456789abcdef") != 64U
        || (strcmp(argv[1], "initialize") != 0 && strcmp(argv[1], "open") != 0 && strcmp(argv[1], "cleanup") != 0)) {
        errno = EINVAL; coordinator_error(&failure, "arguments", true); failure_reply(&owner, &failure); return 1;
    }
    if (strcmp(argv[1], "initialize") == 0) mode = MODE_INITIALIZE;
    if (strcmp(argv[1], "cleanup") == 0) mode = MODE_CLEANUP;
    memcpy(owner.key, argv[2], 65U);
    snprintf(owner.lock_name, sizeof(owner.lock_name), "%s.lock", owner.key);
    snprintf(owner.state_name, sizeof(owner.state_name), "%s.state", owner.key);
    snprintf(owner.temp_name, sizeof(owner.temp_name), "%s.next", owner.key);
    if (!coordinator_open(&owner, mode, &failure)) {
        failure_reply(&owner, &failure);
        if (!owner.claimed || fflush(stdout) != 0) { coordinator_close(&owner); return 1; }
    } else opened(&owner);
    if (fflush(stdout) != 0) { coordinator_close(&owner); return 1; }
    for (;;) {
        char command[64]; failure = (struct coordinator_failure){0};
        if (!command_line(command, &failure)) {
            if (failure.reason) failure_reply(&owner, &failure);
            break;
        }
        if (strcmp(command, "CLOSE") == 0) {
            coordinator_close(&owner); puts("{\"kind\":\"closed\"}"); fflush(stdout); return 0;
        }
        if (!dispatch(&owner, command, &failure)) failure_reply(&owner, &failure);
        if (!owner.claimed || fflush(stdout) != 0) break;
    }
    bool failed = failure.reason != NULL || ferror(stdin);
    coordinator_close(&owner);
    return failed ? 1 : 0;
}
