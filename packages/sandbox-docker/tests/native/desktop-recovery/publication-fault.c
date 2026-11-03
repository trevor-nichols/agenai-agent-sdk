#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Diagnostic-only dyld interposer: one directory fsync fails after real rename. */
static int publication_fsync(int fd) {
    static bool fired;
    int saved = errno;
    const char *directory = getenv("AGENAI_TEST_FAULT_DIRECTORY");
    const char *stage = getenv("AGENAI_TEST_FAULT_STAGE");
    const char *marker = getenv("AGENAI_TEST_FAULT_MARKER");
    const char *trigger = getenv("AGENAI_TEST_FAULT_READ_TRIGGER");
    char path[PATH_MAX], filename[64]; struct stat published;
    if (!fired && directory && stage && marker && fcntl(fd, F_GETPATH, path) == 0
        && strcmp(path, directory) == 0) {
        bool receipt_read = strcmp(stage, "receipt_read") == 0 && trigger && access(trigger, F_OK) == 0;
        bool native_stage = strcmp(stage, "admission") == 0 || strcmp(stage, "armed") == 0 || strcmp(stage, "outcome") == 0;
        if (native_stage) snprintf(filename, sizeof(filename), "%s.json", stage);
        if (receipt_read || (native_stage && fstatat(fd, filename, &published, AT_SYMLINK_NOFOLLOW) == 0 && S_ISREG(published.st_mode))) {
            int output = open(marker, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
            if (output >= 0) {
                fired = true;
                static const char message[] = "injected receipt directory fsync EIO\n";
                (void)write(output, message, sizeof(message) - 1U); close(output);
                errno = EIO; return -1;
            }
        }
    }
    errno = saved; return fsync(fd);
}

__attribute__((used)) static const struct {
    int (*replacement)(int);
    int (*original)(int);
} interposer __attribute__((section("__DATA,__interpose"))) = { publication_fsync, fsync };
