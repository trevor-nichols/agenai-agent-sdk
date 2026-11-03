#include "recovery.h"
#include "profile.h"
#include <Security/Security.h>
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>

const struct image_profile recovery_images[] = { RECOVERY_IMAGE_ROWS };
const size_t recovery_image_count = sizeof(recovery_images) / sizeof(recovery_images[0]);
_Static_assert(sizeof(recovery_images) / sizeof(recovery_images[0]) <= RECOVERY_IMAGE_MAX, "fixed image cache bound");

static bool code_identity(SecCodeRef code, const struct image_profile *image, struct coordinator_failure *f) {
    CFDictionaryRef info = NULL;
    if (SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info) != errSecSuccess) return recovery_fail(f, "code_information");
    CFStringRef id = CFDictionaryGetValue(info, kSecCodeInfoIdentifier);
    CFStringRef team = CFDictionaryGetValue(info, kSecCodeInfoTeamIdentifier);
    char identifier[256], team_text[256];
    bool ok = id && team && CFGetTypeID(id) == CFStringGetTypeID() && CFGetTypeID(team) == CFStringGetTypeID()
        && CFStringGetCString(id, identifier, sizeof(identifier), kCFStringEncodingUTF8)
        && CFStringGetCString(team, team_text, sizeof(team_text), kCFStringEncodingUTF8)
        && strcmp(identifier, image->identifier) == 0 && strcmp(team_text, RECOVERY_TEAM) == 0;
    CFRelease(info); return ok ? true : recovery_fail(f, "code_identity");
}
static bool same_code(SecCodeRef left, SecCodeRef right, struct coordinator_failure *f) {
    CFDictionaryRef a = NULL, b = NULL;
    bool ok = SecCodeCopySigningInformation(left, kSecCSSigningInformation, &a) == errSecSuccess
        && SecCodeCopySigningInformation(right, kSecCSSigningInformation, &b) == errSecSuccess;
    CFDataRef ah = a ? CFDictionaryGetValue(a, kSecCodeInfoUnique) : NULL;
    CFDataRef bh = b ? CFDictionaryGetValue(b, kSecCodeInfoUnique) : NULL;
    ok = ok && ah && bh && CFGetTypeID(ah) == CFDataGetTypeID() && CFGetTypeID(bh) == CFDataGetTypeID() && CFEqual(ah, bh);
    if (a) CFRelease(a); if (b) CFRelease(b);
    return ok ? true : recovery_fail(f, "running_image_mismatch");
}
static bool unchanged_image(const struct file_fact *file, struct coordinator_failure *f) {
    struct stat current;
    if (!recovery_file_check(file, f)) return false;
    if (fstat(file->fd, &current) < 0) return coordinator_error(f, "image_stat", false);
    const struct stat *before = &file->identity;
    return current.st_size == before->st_size
        && current.st_mtimespec.tv_sec == before->st_mtimespec.tv_sec && current.st_mtimespec.tv_nsec == before->st_mtimespec.tv_nsec
        && current.st_ctimespec.tv_sec == before->st_ctimespec.tv_sec && current.st_ctimespec.tv_nsec == before->st_ctimespec.tv_nsec
        ? true : recovery_fail(f, "image_changed");
}
static bool installed_code(struct recovery *r, size_t index, struct coordinator_failure *f) {
    struct code_cache *cached = &r->images[index];
    if (cached->valid) return unchanged_image(&cached->file, f);
    const struct image_profile *image = &recovery_images[index]; char path[4096];
    snprintf(path, sizeof(path), "%s/%s", RECOVERY_APPLICATION, image->relative);
    struct file_fact file = { .fd = -1 };
    if (!recovery_file_open(path, &file, false, f)) return false;
    char sha[65]; bool ok = recovery_hash_fd(file.fd, 512LL * 1024LL * 1024LL, sha, f);
    if (ok && strcmp(sha, image->sha) != 0) ok = recovery_fail(f, "image_hash");
    CFURLRef url = NULL; SecStaticCodeRef code = NULL;
    if (ok) {
        url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)path, (CFIndex)strlen(path), false);
        if (!url || SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) != errSecSuccess
            || SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckAllArchitectures, NULL) != errSecSuccess)
            ok = recovery_fail(f, "static_code_invalid");
    }
    if (ok) ok = code_identity((SecCodeRef)code, image, f);
    if (ok) ok = unchanged_image(&file, f);
    if (url) CFRelease(url);
    if (!ok) { if (code) CFRelease(code); close(file.fd); return false; }
    *cached = (struct code_cache){ .file = file, .code = code, .valid = true }; return true;
}
enum code_observation recovery_code_observe(struct recovery *r, size_t index, pid_t pid, struct json *j, struct coordinator_failure *f) {
    if (index >= recovery_image_count) { recovery_fail(f, "image_index"); return CODE_INVALID_INSTALLATION; }
    if (!installed_code(r, index, f)) return CODE_INVALID_INSTALLATION;
    const struct image_profile *image = &recovery_images[index];
    SecCodeRef code = (SecCodeRef)r->images[index].code;
    enum code_observation result = CODE_INVALID_INSTALLATION; bool ok = true;
    if (ok && pid > 0) {
        result = CODE_INVALID_PROCESS;
        CFNumberRef value = CFNumberCreate(NULL, kCFNumberIntType, &pid);
        const void *keys[] = { kSecGuestAttributePid }; const void *values[] = { value };
        CFDictionaryRef attrs = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        SecCodeRef guest = NULL;
        if (!attrs || SecCodeCopyGuestWithAttributes(NULL, attrs, kSecCSDefaultFlags, &guest) != errSecSuccess
            || SecCodeCheckValidity(guest, kSecCSStrictValidate, NULL) != errSecSuccess) ok = recovery_fail(f, "dynamic_code_invalid");
        if (ok) ok = code_identity(guest, image, f) && same_code(guest, (SecCodeRef)code, f);
        if (guest) CFRelease(guest); if (attrs) CFRelease(attrs); if (value) CFRelease(value);
    }
    struct coordinator_failure changed = {0};
    if (!unchanged_image(&r->images[index].file, &changed)) { *f = changed; result = CODE_INVALID_INSTALLATION; ok = false; }
    if (ok && j) json_raw(j, "{\"role\":\"%s\",\"sha256\":\"%s\",\"identifier\":\"%s\",\"team\":\"%s\"}", image->role, image->sha, image->identifier, RECOVERY_TEAM);
    return ok ? CODE_VALIDATED : result;
}
bool recovery_code(struct recovery *r, size_t index, pid_t pid, struct json *j, struct coordinator_failure *f) {
    return recovery_code_observe(r, index, pid, j, f) == CODE_VALIDATED;
}
void recovery_code_close(struct recovery *r) {
    for (size_t i = 0; i < RECOVERY_IMAGE_MAX; i++) if (r->images[i].valid) {
        CFRelease((SecStaticCodeRef)r->images[i].code); close(r->images[i].file.fd);
        r->images[i] = (struct code_cache){0};
    }
}
