#include "recovery.h"
#include "profile.h"
#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/wait.h>
#include <unistd.h>

/* Real owned fork/exec/exit events, with a scripted signature-verifier boundary.
 * The path adapter maps only this fixture's child to two fixed image roles.
 * It never examines Docker processes, sockets, authority files or credentials. */
const struct image_profile recovery_images[] = { RECOVERY_IMAGE_ROWS };
const size_t recovery_image_count = sizeof(recovery_images) / sizeof(recovery_images[0]);
static pid_t actor = -1;
static int gate = -1;
static const char *scenario;
static char executable[PROC_PIDPATHINFO_MAXSIZE];
static unsigned validations;

static void join_actor(void) {
    if (gate >= 0) { close(gate); gate = -1; }
    if (actor > 0) {
        (void)kill(actor, SIGKILL);
        int status; while (waitpid(actor, &status, 0) < 0 && errno == EINTR) {}
        actor = -1;
    }
}
static void failed(const char *message) { fprintf(stderr, "%s: %s\n", scenario, message); join_actor(); exit(1); }
#define REQUIRE(condition) do { if (!(condition)) failed(#condition); } while (0)
static void expired(int signal) { (void)signal; if (actor > 0) { kill(actor, SIGKILL); waitpid(actor, NULL, 0); } _exit(124); }

int diagnostic_listpids(uint32_t type, uint32_t uid, void *buffer, int size) {
    REQUIRE(type == PROC_UID_ONLY && uid == getuid() && size >= (int)sizeof(actor));
    memcpy(buffer, &actor, sizeof(actor)); return (int)sizeof(actor);
}
int diagnostic_pidpath(int pid, void *buffer, uint32_t size) {
    REQUIRE(pid == actor);
    char actual[PROC_PIDPATHINFO_MAXSIZE]; int n = proc_pidpath(pid, actual, sizeof(actual));
    if (n <= 0) return n;
    const char *relative = strcmp(actual, executable) == 0 ? recovery_images[0].relative : recovery_images[9].relative;
    if (strcmp(scenario, "unknown") == 0) relative = "Contents/MacOS/unadmitted-fixture";
    n = snprintf(buffer, size, "%s/%s", RECOVERY_APPLICATION, relative);
    REQUIRE(n > 0 && (uint32_t)n < size); return n;
}
static void transition(char command, uint32_t event_kind) {
    int queue = kqueue(); REQUIRE(queue >= 0);
    struct kevent watch, event;
    EV_SET(&watch, (uintptr_t)actor, EVFILT_PROC, EV_ADD | EV_CLEAR, event_kind, 0, NULL);
    REQUIRE(kevent(queue, &watch, 1, NULL, 0, NULL) == 0);
    REQUIRE(write(gate, &command, 1U) == 1);
    struct timespec deadline = { .tv_sec = 2 };
    REQUIRE(kevent(queue, NULL, 0, &event, 1, &deadline) == 1);
    REQUIRE(event.filter == EVFILT_PROC && (event.fflags & event_kind) != 0 && (event.flags & EV_ERROR) == 0);
    close(queue);
}
enum code_observation recovery_code_observe(struct recovery *r, size_t image, pid_t pid, struct json *j, struct coordinator_failure *f) {
    (void)r; (void)j; REQUIRE(pid == actor); validations++;
    if (strcmp(scenario, "stable-invalid") == 0) { recovery_fail(f, "dynamic_code_invalid"); return CODE_INVALID_PROCESS; }
    if (strcmp(scenario, "bound") == 0) {
        transition('r', NOTE_EXEC); recovery_fail(f, "dynamic_code_invalid"); return CODE_INVALID_PROCESS;
    }
    if (validations == 1U && strcmp(scenario, "stable-valid") != 0) {
        transition(strcmp(scenario, "exit") == 0 ? 'e' : 'x', strcmp(scenario, "exit") == 0 ? NOTE_EXIT : NOTE_EXEC);
        if (strcmp(scenario, "installation-invalid") == 0) { recovery_fail(f, "image_hash"); return CODE_INVALID_INSTALLATION; }
        recovery_fail(f, "dynamic_code_invalid"); return CODE_INVALID_PROCESS;
    }
    REQUIRE(image == (strcmp(scenario, "stable-valid") == 0 ? 0U : 9U)); return CODE_VALIDATED;
}
bool recovery_code(struct recovery *r, size_t image, pid_t pid, struct json *j, struct coordinator_failure *f) {
    return recovery_code_observe(r, image, pid, j, f) == CODE_VALIDATED;
}
static void actor_loop(void) {
    char command;
    while (read(STDIN_FILENO, &command, 1U) == 1) {
        if (command == 'e') _exit(0);
        if (command == 'x') execl("/bin/sleep", "sleep", "30", (char *)NULL);
        if (command == 'r') execl(executable, executable, "--actor", (char *)NULL);
        _exit(127);
    }
    _exit(0);
}
int main(int argc, char **argv) {
    REQUIRE(proc_pidpath(getpid(), executable, sizeof(executable)) > 0);
    if (argc == 2 && strcmp(argv[1], "--actor") == 0) actor_loop();
    REQUIRE(argc == 2); scenario = argv[1];
    REQUIRE(signal(SIGALRM, expired) != SIG_ERR); alarm(10U);
    int pipefd[2]; REQUIRE(pipe(pipefd) == 0);
    actor = fork(); REQUIRE(actor >= 0);
    if (actor == 0) {
        close(pipefd[1]); REQUIRE(dup2(pipefd[0], STDIN_FILENO) == STDIN_FILENO);
        int limit = getdtablesize(); for (int fd = 3; fd < limit; fd++) close(fd);
        actor_loop();
    }
    close(pipefd[0]); gate = pipefd[1];
    struct recovery r = {0}; struct process_fact facts[RECOVERY_PROCESS_MAX]; size_t count = 0;
    struct coordinator_failure failure = {0};
    bool ok = recovery_processes(&r, facts, &count, CENSUS_OBSERVING, &failure);
    fprintf(stderr, "%s observation: ok=%d count=%zu validations=%u failure=%s errno=%d\n", scenario, ok, count, validations,
        failure.reason ? failure.reason : "none", failure.error);
    if (strcmp(scenario, "exec") == 0 || strcmp(scenario, "stable-valid") == 0) {
        REQUIRE(ok && count == 1U && facts[0].pid == actor);
        REQUIRE(facts[0].image == (strcmp(scenario, "exec") == 0 ? 9U : 0U));
    } else if (strcmp(scenario, "exit") == 0) REQUIRE(ok && count == 0U && !failure.reason);
    else {
        const char *expected = strcmp(scenario, "stable-invalid") == 0 ? "dynamic_code_invalid"
            : strcmp(scenario, "installation-invalid") == 0 ? "image_hash"
            : strcmp(scenario, "unknown") == 0 ? "unknown_bundle_process" : "process_epoch_bound";
        REQUIRE(!ok && failure.reason && strcmp(failure.reason, expected) == 0);
    }
    join_actor();
    printf("{\"case\":\"%s\",\"signatureBoundary\":\"scripted\",\"processEvents\":\"native-owned\",\"actorsJoined\":true}\n", scenario);
    return 0;
}
