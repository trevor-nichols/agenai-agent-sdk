#include "recovery.h"
#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <mach/mach_time.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

void json_init(struct json *j) { *j = (struct json){ .valid = true }; }
void json_free(struct json *j) { free(j->data); *j = (struct json){0}; }
static bool json_grow(struct json *j, size_t amount) {
    if (!j->valid || amount > 6U * COORDINATOR_MAX_FRAME || j->length > 6U * COORDINATOR_MAX_FRAME - amount) {
        j->valid = false; return false;
    }
    size_t needed = j->length + amount + 1U;
    if (needed > j->capacity) {
        size_t capacity = needed * 2U;
        char *next = realloc(j->data, capacity);
        if (!next) { j->valid = false; return false; }
        j->data = next; j->capacity = capacity;
    }
    return true;
}
void json_raw(struct json *j, const char *format, ...) {
    va_list args, copy; va_start(args, format); va_copy(copy, args);
    int n = vsnprintf(NULL, 0, format, copy); va_end(copy);
    if (n < 0 || !json_grow(j, (size_t)n)) { j->valid = false; va_end(args); return; }
    vsnprintf(j->data + j->length, (size_t)n + 1U, format, args); va_end(args); j->length += (size_t)n;
}
void json_string(struct json *j, const char *bytes, size_t length) {
    json_raw(j, "\"");
    for (size_t i = 0; i < length; i++) {
        unsigned char c = (unsigned char)bytes[i];
        if (c == '"' || c == '\\') json_raw(j, "\\%c", c);
        else if (c < 32U) json_raw(j, "\\u%04x", (unsigned)c);
        else json_raw(j, "%c", c);
    }
    json_raw(j, "\"");
}
void json_base64(struct json *j, const unsigned char *bytes, size_t length) {
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    json_raw(j, "\"");
    for (size_t i = 0; i < length; i += 3U) {
        uint32_t n = (uint32_t)bytes[i] << 16U;
        if (i + 1U < length) n |= (uint32_t)bytes[i + 1U] << 8U;
        if (i + 2U < length) n |= bytes[i + 2U];
        json_raw(j, "%c%c%c%c", alphabet[(n >> 18U) & 63U], alphabet[(n >> 12U) & 63U],
            i + 1U < length ? alphabet[(n >> 6U) & 63U] : '=', i + 2U < length ? alphabet[n & 63U] : '=');
    }
    json_raw(j, "\"");
}
void json_file_identity(struct json *j, const struct stat *s) {
    json_raw(j, "{\"device\":\"%llu\",\"inode\":\"%llu\",\"uid\":%u,\"mode\":%u,\"size\":\"%llu\",\"birthSeconds\":\"%llu\",\"birthNanoseconds\":%ld}",
        (unsigned long long)s->st_dev, (unsigned long long)s->st_ino, s->st_uid, s->st_mode & 07777,
        (unsigned long long)s->st_size, (unsigned long long)s->st_birthtimespec.tv_sec, s->st_birthtimespec.tv_nsec);
}
void recovery_sha(const void *bytes, size_t length, char sha[65]) {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(bytes, (CC_LONG)length, digest);
    for (size_t i = 0; i < sizeof(digest); i++) snprintf(sha + i * 2U, 3U, "%02x", digest[i]);
}
bool recovery_hash_fd(int fd, off_t max, char sha[65], struct coordinator_failure *f) {
    struct stat before, after;
    if (fstat(fd, &before) < 0) return coordinator_error(f, "image_stat", false);
    if (!S_ISREG(before.st_mode) || before.st_size <= 0 || before.st_size > max) return recovery_fail(f, "image_bound");
    CC_SHA256_CTX ctx; CC_SHA256_Init(&ctx); unsigned char bytes[RECOVERY_CHUNK]; off_t at = 0;
    while (at < before.st_size) {
        size_t n = (size_t)(before.st_size - at); if (n > sizeof(bytes)) n = sizeof(bytes);
        ssize_t count = pread(fd, bytes, n, at);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return coordinator_error(f, "image_read", false);
        CC_SHA256_Update(&ctx, bytes, (CC_LONG)count); at += count;
    }
    if (fstat(fd, &after) < 0) return coordinator_error(f, "image_stat", false);
    if (!coordinator_same(&before, &after) || before.st_size != after.st_size
        || before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec || before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec)
        return recovery_fail(f, "image_changed");
    unsigned char digest[32]; CC_SHA256_Final(digest, &ctx);
    for (size_t i = 0; i < sizeof(digest); i++) snprintf(sha + i * 2U, 3U, "%02x", digest[i]);
    return true;
}
bool recovery_hex(const char *v) {
    if (strlen(v) != 64U) return false;
    for (size_t i = 0; i < 64U; i++) if (!((v[i] >= '0' && v[i] <= '9') || (v[i] >= 'a' && v[i] <= 'f'))) return false;
    return true;
}
bool recovery_uuid(const char *v) {
    if (strlen(v) != 36U || v[14] != '4' || !strchr("89ab", v[19])) return false;
    for (size_t i = 0; i < 36U; i++) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (v[i] != '-') return false; }
        else if (!((v[i] >= '0' && v[i] <= '9') || (v[i] >= 'a' && v[i] <= 'f'))) return false;
    }
    return true;
}
bool recovery_decimal(const char *v, uint64_t *n, bool positive) {
    if (!*v || (v[0] == '0' && v[1])) return false;
    uint64_t value = 0;
    for (; *v; v++) { if (*v < '0' || *v > '9' || value > (9007199254740991ULL - (unsigned)(*v - '0')) / 10U) return false; value = value * 10U + (unsigned)(*v - '0'); }
    if (positive && value == 0) return false; *n = value; return true;
}
uint64_t recovery_now(void) {
    mach_timebase_info_data_t base; mach_timebase_info(&base);
    return (uint64_t)((__uint128_t)mach_continuous_time() * base.numer / base.denom / 1000000U);
}
bool recovery_fail(struct coordinator_failure *f, const char *reason) { errno = EINVAL; return coordinator_error(f, reason, false); }
bool recovery_read_payload(size_t n, char **body, struct coordinator_failure *f) {
    char *bytes = malloc(n + 1U); if (!bytes) return coordinator_error(f, "payload_allocation", false);
    size_t at = 0; while (at < n) { size_t got = fread(bytes + at, 1U, n - at, stdin); if (!got) { free(bytes); return recovery_fail(f, "payload_incomplete"); } at += got; }
    if (getchar() != '\n' || !coordinator_utf8((unsigned char *)bytes, n)) { free(bytes); return recovery_fail(f, "payload_framing"); }
    bytes[n] = 0; *body = bytes; return true;
}
void recovery_reply(const struct json *j) {
    if (!j->valid || !j->data) return;
    fwrite(j->data, 1U, j->length, stdout); putchar('\n'); fflush(stdout);
}
