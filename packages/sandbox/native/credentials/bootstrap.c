#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include "protocol.h"

static unsigned char secret[AGENAI_CREDENTIAL_MAX_BYTES];

static void wipe(void) {
    volatile unsigned char *p = secret;
    for (size_t i = 0; i < sizeof(secret); ++i) p[i] = 0;
}

static int fail(const char *code) {
    wipe();
    dprintf(STDERR_FILENO, "credential_bootstrap:%s\n", code);
    return 70;
}

static int read_exact(void *buffer, size_t length) {
    unsigned char *p = buffer;
    while (length > 0) {
        ssize_t got = read(STDIN_FILENO, p, length);
        if (got < 0 && errno == EINTR) continue;
        if (got <= 0) return -1;
        p += got;
        length -= (size_t)got;
    }
    return 0;
}

static int write_marker(const char *text, size_t length) {
    while (length > 0) {
        ssize_t wrote = write(STDOUT_FILENO, text, length);
        if (wrote < 0 && errno == EINTR) continue;
        if (wrote <= 0) return -1;
        text += wrote;
        length -= (size_t)wrote;
    }
    return 0;
}

static int owned_directory(int fd) {
    struct stat st;
    return fstat(fd, &st) == 0 && S_ISDIR(st.st_mode)
        && st.st_uid == getuid() && (st.st_mode & 07777) == 0700;
}

int main(int argc, char **argv) {
    if (getuid() == 0 || geteuid() != getuid()) return fail("non_root_required");
    if (argc < 2 || argv[1][0] != '/') return fail("invalid_command");
    if (write_marker(AGENAI_CREDENTIAL_HELLO, sizeof(AGENAI_CREDENTIAL_HELLO) - 1) < 0)
        return fail("hello_write_failed");

    unsigned char header[AGENAI_CREDENTIAL_HEADER_BYTES];
    char name[AGENAI_CREDENTIAL_MAX_NAME_BYTES + 1];
    if (read_exact(header, sizeof(header)) < 0) return fail("truncated_frame");
    size_t name_length = ((size_t)header[4] << 8) | header[5];
    size_t length = ((size_t)header[8] << 24) | ((size_t)header[9] << 16)
        | ((size_t)header[10] << 8) | header[11];
    if (memcmp(header, AGENAI_CREDENTIAL_MAGIC, 4) != 0 || header[6] != 0 || header[7] != 0
        || name_length == 0 || name_length > AGENAI_CREDENTIAL_MAX_NAME_BYTES
        || length == 0 || length > AGENAI_CREDENTIAL_MAX_BYTES) return fail("invalid_frame");
    if (read_exact(name, name_length) < 0) return fail("truncated_frame");
    name[name_length] = '\0';
    size_t first = name[0] == '.' ? 1u : 0u;
    if (first == name_length) return fail("invalid_name");
    for (size_t i = 0; i < name_length; ++i) {
        unsigned char c = (unsigned char)name[i];
        if (i == 0 && first == 1) continue;
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
            || (c >= '0' && c <= '9') || (i > first && (c == '_' || c == '-' || c == '.'))))
            return fail("invalid_name");
    }
    if (read_exact(secret, length) < 0) return fail("truncated_frame");

    int root = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    int home_parent = root < 0 ? -1 : openat(root, "home", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    int home = home_parent < 0 ? -1 : openat(home_parent, "sandbox", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    int root_closed = root < 0 ? 0 : close(root);
    int parent_closed = home_parent < 0 ? 0 : close(home_parent);
    if (root_closed < 0 || parent_closed < 0 || home < 0 || !owned_directory(home))
        return fail("private_home_unavailable");

    mode_t inherited_umask = umask(0077);
    if (mkdirat(home, ".agenai-credentials", 0700) < 0) return fail("private_directory_unavailable");
    int directory = openat(home, ".agenai-credentials", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    int home_closed = close(home);
    if (home_closed < 0 || directory < 0 || !owned_directory(directory)) return fail("private_directory_invalid");
    int file = openat(directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (file < 0) return fail("private_file_unavailable");
    struct stat st;
    if (fstat(file, &st) < 0 || !S_ISREG(st.st_mode) || st.st_uid != getuid()
        || (st.st_mode & 07777) != 0600 || st.st_nlink != 1) return fail("private_file_invalid");
    size_t offset = 0;
    while (offset < length) {
        ssize_t wrote = write(file, secret + offset, length - offset);
        if (wrote < 0 && errno == EINTR) continue;
        if (wrote <= 0) return fail("private_file_write_failed");
        offset += (size_t)wrote;
    }
    int file_closed = close(file);
    wipe();
    if (file_closed < 0) return fail("private_file_close_failed");
    if (close(directory) < 0) return fail("private_directory_close_failed");
    umask(inherited_umask);
    if (write_marker(AGENAI_CREDENTIAL_PREPARED, sizeof(AGENAI_CREDENTIAL_PREPARED) - 1) < 0)
        return fail("prepared_write_failed");
    execv(argv[1], argv + 1);
    return fail("native_exec_failed");
}
