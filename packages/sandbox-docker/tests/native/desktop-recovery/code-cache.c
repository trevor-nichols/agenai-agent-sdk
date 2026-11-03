#include "recovery.h"
#include "profile.h"
#include <fcntl.h>
#include <string.h>
#include <unistd.h>

/* The runner selects an exclusively owned copied stock signed image. No process
 * or Docker authority is consulted; the production static verifier is unchanged. */
#define REQUIRE(condition) do { if (!(condition)) { fprintf(stderr, "line %u: %s (%s)\n", __LINE__, #condition, failure.reason ? failure.reason : "none"); recovery_code_close(&r); return 1; } } while (0)
int main(int argc, char **argv) {
    struct recovery r = {0}; struct coordinator_failure failure = {0};
    REQUIRE(argc == 2);
    REQUIRE(recovery_code(&r, 0U, 0, NULL, &failure));
    REQUIRE(recovery_code(&r, 0U, 0, NULL, &failure));
    if (strcmp(argv[1], "stable") != 0) {
        if (strcmp(argv[1], "replace") == 0) REQUIRE(rename(RECOVERY_APPLICATION "/replacement", RECOVERY_APPLICATION "/owned-image") == 0);
        else {
            REQUIRE(strcmp(argv[1], "restore-mtime") == 0);
            int fd = open(RECOVERY_APPLICATION "/owned-image", O_RDWR | O_NOFOLLOW | O_CLOEXEC); REQUIRE(fd >= 0);
            struct stat original; REQUIRE(fstat(fd, &original) == 0 && original.st_size > 0);
            unsigned char byte; REQUIRE(pread(fd, &byte, 1U, original.st_size - 1) == 1);
            byte ^= 1U; REQUIRE(pwrite(fd, &byte, 1U, original.st_size - 1) == 1 && fsync(fd) == 0);
            struct timespec times[] = { original.st_atimespec, original.st_mtimespec }; REQUIRE(futimens(fd, times) == 0); close(fd);
        }
        REQUIRE(recovery_code_observe(&r, 0U, 0, NULL, &failure) == CODE_INVALID_INSTALLATION);
        REQUIRE(strcmp(failure.reason, strcmp(argv[1], "replace") == 0 ? "file_replaced" : "image_changed") == 0);
    }
    recovery_code_close(&r);
    printf("{\"case\":\"%s\",\"scope\":\"owned-copied-signed-image\",\"staticVerifier\":\"production\"}\n", argv[1]);
    return 0;
}
