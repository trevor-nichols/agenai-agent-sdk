#include <errno.h>
#include <pwd.h>
#include <stdlib.h>
#include <sys/types.h>

/* The real account entry with its home replaced by an exclusively owned scratch directory. */
int diagnostic_getpwuid_r(uid_t uid, struct passwd *account, char *buffer, size_t size, struct passwd **result) {
    int error = getpwuid_r(uid, account, buffer, size, result);
    if (error != 0 || *result == NULL) return error;
    char *home = getenv("AGENAI_TEST_HOME");
    if (home == NULL) { *result = NULL; return EINVAL; }
    account->pw_dir = home;
    return 0;
}
