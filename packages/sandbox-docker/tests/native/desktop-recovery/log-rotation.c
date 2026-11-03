#include "recovery.h"
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Production log reads and held descriptors on an exclusively owned synthetic
 * home. The fstatat boundary triggers a real rename/delete after readdir. */
static const char *scenario = "setup";
static char directory[4096];
static bool active;
static unsigned triggered;
static uint64_t temporary_churn_until;
static struct recovery r = { .queue = -1, .disk.fd = -1, .settings.fd = -1, .components.fd = -1 };
static struct coordinator_failure failure;
static void failed(const char *condition, unsigned line) {
    fprintf(stderr, "%s line %u: %s (%s)\n", scenario, line, condition, failure.reason ? failure.reason : "none");
    recovery_files_close(&r); exit(1);
}
#define REQUIRE(condition) do { if (!(condition)) failed(#condition, __LINE__); } while (0)
static void write_log(const char *name, const char *bytes, bool append) {
    char path[4096]; REQUIRE(snprintf(path, sizeof(path), "%s/%s", directory, name) < (int)sizeof(path));
    int fd = open(path, O_WRONLY | O_NOFOLLOW | O_CLOEXEC | (append ? O_APPEND : O_CREAT | O_EXCL), 0600);
    REQUIRE(fd >= 0 && write(fd, bytes, strlen(bytes)) == (ssize_t)strlen(bytes)); close(fd);
}
int diagnostic_fstatat(int fd, const char *name, struct stat *s, int flags) {
    char path[4096];
    bool own = active && fcntl(fd, F_GETPATH, path) == 0 && strcmp(path, directory) == 0;
    bool held = strncmp(scenario, "held-", 5U) == 0;
    bool pending = strncmp(scenario, "unheld-", 7U) == 0;
    bool churn = strcmp(scenario, "churn") == 0 || (strcmp(scenario, "temporary-churn") == 0 && recovery_now() < temporary_churn_until);
    if (own && ((triggered == 0 && ((held && strcmp(name, "console.log.0") == 0)
        || (pending && strcmp(name, "console.log.pending") == 0)))
        || (churn && (strcmp(name, "console.log.0") == 0 || strcmp(name, "console.log.1") == 0)))) {
        triggered++;
        if (churn) REQUIRE(renameat(fd, name, fd, strcmp(name, "console.log.0") == 0 ? "console.log.1" : "console.log.0") == 0);
        else if (held) {
            if (strcmp(scenario, "held-delete") == 0) REQUIRE(unlinkat(fd, name, 0) == 0);
            else REQUIRE(renameat(fd, name, fd, "console.log.1") == 0);
            if (strcmp(scenario, "held-missing") != 0) {
                REQUIRE(renameat(fd, "console.log", fd, "console.log.0") == 0);
                write_log("console.log", "new-head\n", false);
            }
        } else if (strcmp(scenario, "unheld-delete") == 0) REQUIRE(unlinkat(fd, name, 0) == 0);
        else REQUIRE(renameat(fd, name, fd, "console.log.moved") == 0);
    }
    return fstatat(fd, name, s, flags);
}
int diagnostic_lstat(const char *path, struct stat *s) {
    if (active && strcmp(path, directory) == 0 && strcmp(scenario, "multi-pass-gap") == 0 && !triggered && r.log_count == 4U) {
        triggered++; write_log("console.log.two", "two\n", false);
    }
    return lstat(path, s);
}
bool recovery_observing(const struct recovery *observer) { return observer->phase == OBS_ARMED; }
bool recovery_observation_result(struct recovery *observer, bool ok, const struct coordinator_failure *f) {
    if (!ok && !observer->observation_failure.reason) observer->observation_failure = *f;
    return ok;
}
bool recovery_events(struct recovery *observer, struct coordinator_failure *f) { (void)observer; (void)f; return true; }
int main(int argc, char **argv) {
    REQUIRE(argc == 3); scenario = argv[1];
    REQUIRE(strlen(argv[2]) < sizeof(r.owner.home)); strcpy(r.owner.home, argv[2]);
    REQUIRE(snprintf(directory, sizeof(directory), "%s/Library/Containers/com.docker.docker/Data/log/vm", argv[2]) < (int)sizeof(directory));
    r.queue = -1; r.disk.fd = r.settings.fd = r.components.fd = -1;
    write_log("init.log", "init-baseline\n", false);
    write_log("console.log", "console-baseline\n", false);
    write_log("console.log.0", "rotation-baseline\n", false);
    REQUIRE(recovery_logs_arm(&r, &failure)); r.phase = OBS_ARMED;
    if (strncmp(scenario, "held-", 5U) == 0) {
        write_log("console.log", "old-tail\n", true); write_log("console.log.0", "rotation-tail\n", true);
    } else if (strncmp(scenario, "unheld-", 7U) == 0) write_log("console.log.pending", "fresh-bytes\n", false);
    else if (strcmp(scenario, "multi-gap") == 0) {
        write_log("console.log.one", "one\n", false); write_log("console.log.two", "two\n", false);
    } else if (strcmp(scenario, "multi-pass-gap") == 0) {
        write_log("console.log.one", "one\n", false);
    } else if (strcmp(scenario, "truncated") == 0) {
        char path[4096]; REQUIRE(snprintf(path, sizeof(path), "%s/console.log", directory) < (int)sizeof(path));
        REQUIRE(truncate(path, 0) == 0);
    } else if (strcmp(scenario, "temporary-churn") == 0) {
        write_log("console.log.0", "rotation-tail\n", true); temporary_churn_until = recovery_now() + 25U;
    } else REQUIRE(strcmp(scenario, "churn") == 0);
    active = true;
    bool refusal = strcmp(scenario, "unheld-delete") == 0 || strcmp(scenario, "multi-gap") == 0
        || strcmp(scenario, "multi-pass-gap") == 0 || strcmp(scenario, "truncated") == 0 || strcmp(scenario, "churn") == 0;
    struct json reply; json_init(&reply);
    bool ok = recovery_log_read(&r, "console", &reply, &failure);
    if (refusal) {
        const char *expected = strcmp(scenario, "churn") == 0 ? "log_census_bound"
            : strcmp(scenario, "truncated") == 0 ? "log_coverage_lost" : "log_rotation_gap";
        REQUIRE(!ok && failure.reason && strcmp(failure.reason, expected) == 0 && r.observation_failure.reason);
    } else {
        REQUIRE(ok); recovery_reply(&reply);
        for (unsigned i = 0; i < 4U; i++) {
            json_free(&reply); json_init(&reply); REQUIRE(recovery_log_read(&r, "console", &reply, &failure)); recovery_reply(&reply);
        }
        REQUIRE(recovery_logs_finish(&r, &failure));
        REQUIRE(triggered > 0U && !r.observation_failure.reason);
    }
    json_free(&reply); recovery_files_close(&r);
    printf("{\"kind\":\"result\",\"case\":\"%s\",\"triggered\":%u,\"failure\":\"%s\"}\n", scenario, triggered, failure.reason ? failure.reason : "none");
    return 0;
}
