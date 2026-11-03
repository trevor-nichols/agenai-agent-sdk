#include "recovery.h"
#include "profile.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <pwd.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/proc_info.h>
#include <sys/proc.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

/* Scripted Desktop composition, real owned watches and unchanged stage/storage code.
 * Facts deliberately violate the production schema; this is not platform evidence.
 * Compile storage.c with coordinator_read renamed to diagnostic_storage_read. */
const struct image_profile recovery_images[] = { RECOVERY_IMAGE_ROWS };
const size_t recovery_image_count = sizeof(recovery_images) / sizeof(recovery_images[0]);
static pid_t actors[3];
static int gates[3];
static size_t actor_count = 2U;
static bool actors_joined[3];
static const char *scratch;
static unsigned log_arm_calls, log_check_calls;
static bool fail_next_read;
static void cleanup_actors(void) {
    for (size_t i = 0; i < actor_count; i++) if (actors[i] > 0 && !actors_joined[i]) {
        close(gates[i]); kill(actors[i], SIGKILL);
        while (waitpid(actors[i], NULL, 0) < 0 && errno == EINTR) {}
        actors_joined[i] = true;
    }
}
static void assertion_failed(const char *condition, unsigned line) {
    fprintf(stderr, "stage fixture line %u: %s\n", line, condition); cleanup_actors(); exit(1);
}
static void expired(int signal) { (void)signal; cleanup_actors(); _exit(124); }
#undef assert
#define assert(condition) do { if (!(condition)) assertion_failed(#condition, __LINE__); } while (0)

bool diagnostic_storage_read(struct coordinator *, char **, size_t *, char[65], struct coordinator_failure *);
bool coordinator_read(struct coordinator *owner, char **bytes, size_t *length, char digest[65], struct coordinator_failure *f) {
    if (fail_next_read) { fail_next_read = false; errno = EIO; return coordinator_error(f, "scripted_state_read", false); }
    return diagnostic_storage_read(owner, bytes, length, digest, f);
}
enum process_observation recovery_process(struct recovery *r, pid_t pid, struct process_fact *out, enum census_mode mode, struct coordinator_failure *f) {
    (void)r;
    size_t i = 0; while (i < actor_count && actors[i] != pid) i++;
    if (i == actor_count) { recovery_fail(f, "scripted_actor_unknown"); return PROCESS_INVALID; }
    struct proc_bsdinfo b;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &b, sizeof(b)) != sizeof(b) || b.pbi_status == SZOMB) return PROCESS_ABSENT;
    if (mode == CENSUS_STOPPED) { recovery_fail(f, "bundle_not_stopped"); return PROCESS_INVALID; }
    char path[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath(pid, path, sizeof(path)) <= 0) { recovery_fail(f, "scripted_actor_path"); return PROCESS_INVALID; }
    *out = (struct process_fact){ .pid = pid, .parent = (pid_t)b.pbi_ppid, .group = (pid_t)b.pbi_pgid,
        .uid = b.pbi_uid, .seconds = b.pbi_start_tvsec, .microseconds = b.pbi_start_tvusec,
        .image = strcmp(path, "/bin/sleep") == 0 ? 9U : i < 2U ? i : 0U };
    return PROCESS_VALIDATED;
}
bool recovery_processes(struct recovery *r, struct process_fact *out, size_t *count, enum census_mode mode, struct coordinator_failure *f) {
    *count = 0;
    for (size_t i = 0; i < actor_count; i++) {
        enum process_observation state = recovery_process(r, actors[i], &out[*count], mode, f);
        if (state == PROCESS_INVALID) return false;
        if (state == PROCESS_VALIDATED) (*count)++;
    }
    return true;
}
void recovery_process_json(struct json *j, const struct process_fact *p) {
    json_raw(j, "{\"diagnosticOnlyPid\":%d}", p->pid);
}
bool recovery_code(struct recovery *r, size_t image, pid_t pid, struct json *j, struct coordinator_failure *f) {
    (void)r; (void)image; (void)pid; (void)f;
    if (j) json_raw(j, "{\"diagnosticOnlyImage\":true}"); return true;
}
void recovery_code_close(struct recovery *r) { (void)r; }
bool recovery_peer(struct recovery *r, struct json *j, struct coordinator_failure *f) {
    (void)r; (void)f; json_raw(j, "{\"diagnosticOnlyPeer\":true}"); return true;
}
bool recovery_files_admission(struct recovery *r, struct json *j, struct coordinator_failure *f) {
    (void)r; (void)f; json_raw(j, "\"diagnosticOnlyStore\":true"); return true;
}
bool recovery_file_check(const struct file_fact *file, struct coordinator_failure *f) { (void)file; (void)f; return true; }
bool recovery_logs_arm(struct recovery *r, struct coordinator_failure *f) {
    log_arm_calls++;
    for (unsigned i = 0; i < 2U; i++) {
        struct log_file *log = &r->logs[i]; *log = (struct log_file){ .file.fd = -1, .source = i };
        snprintf(log->file.path, sizeof(log->file.path), "%s/owned-%u.log", scratch, i);
        log->file.fd = open(log->file.path, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
        if (log->file.fd < 0 || write(log->file.fd, "initial\n", 8U) != 8 || fstat(log->file.fd, &log->file.identity) < 0)
            return coordinator_error(f, "scripted_log_create", false);
        log->initial = log->cursor = 8U; r->log_count++;
        struct kevent event;
        EV_SET(&event, (uintptr_t)log->file.fd, EVFILT_VNODE, EV_ADD | EV_CLEAR, NOTE_REVOKE | NOTE_WRITE, 0, NULL);
        if (kevent(r->queue, &event, 1, NULL, 0, NULL) < 0) return coordinator_error(f, "scripted_log_watch", false);
    }
    fail_next_read = true; return true;
}
bool recovery_logs_check(struct recovery *r, struct coordinator_failure *f) {
    log_check_calls++;
    for (size_t i = 0; i < r->log_count; i++) {
        struct stat s;
        if (fstat(r->logs[i].file.fd, &s) < 0 || s.st_size < (off_t)r->logs[i].cursor)
            return recovery_observation_result(r, recovery_fail(f, "scripted_owned_log_gap"), f);
    }
    return true;
}
bool recovery_logs_finish(struct recovery *r, struct coordinator_failure *f) { return recovery_logs_check(r, f); }
void recovery_files_close(struct recovery *r) {
    for (size_t i = 0; i < r->log_count; i++) close(r->logs[i].file.fd);
    r->log_count = 0;
}
static void spawn_actors(size_t begin, size_t end) {
    for (size_t i = begin; i < end; i++) {
        int gate[2]; assert(pipe(gate) == 0);
        pid_t pid = fork(); assert(pid >= 0);
        if (pid == 0) {
            close(gate[1]); char command;
            if (read(gate[0], &command, 1U) == 1) {
                if (command == 's') execl("/bin/sleep", "sleep", "30", (char *)NULL);
                else execl("/usr/bin/true", "true", (char *)NULL);
            }
            _exit(0);
        }
        close(gate[0]); actors[i] = pid; gates[i] = gate[1];
    }
}
static void join_actors(void) {
    for (size_t i = 0; i < actor_count; i++) {
        close(gates[i]); kill(actors[i], SIGKILL);
        int status; assert(waitpid(actors[i], &status, 0) == actors[i]);
        actors_joined[i] = true;
    }
}
int main(int argc, char **argv) {
    assert(atexit(cleanup_actors) == 0 && signal(SIGALRM, expired) != SIG_ERR); alarm(20U);
    assert(argc == 4 && recovery_hex(argv[2]));
    assert(strcmp(argv[2], "13f0b9b23b2cd1b55ddfcd910c252cb16984e9b7e1f9ed0b9073149fe87585f9") != 0);
    bool exec_case = strcmp(argv[1], "exec") == 0, auxiliary_case = strcmp(argv[1], "auxiliary") == 0;
    assert(exec_case || auxiliary_case || strcmp(argv[1], "retry") == 0);
    struct rlimit no_core = {0}; assert(setrlimit(RLIMIT_CORE, &no_core) == 0);
    scratch = argv[3];
    struct passwd *pw = getpwuid(getuid()); assert(pw);
    char path[4096]; const char *suffixes[] = { "lock", "state", "next", "recovery-evidence-v1" };
    for (size_t i = 0; i < 4U; i++) {
        snprintf(path, sizeof(path), "%s/Library/Application Support/AgenAI/sandbox-docker/desktop-coordination-v1/%s.%s", pw->pw_dir, argv[2], suffixes[i]);
        struct stat s; errno = 0; assert(lstat(path, &s) < 0 && errno == ENOENT);
    }
    spawn_actors(0U, actor_count);
    printf("{\"diagnosticEntry\":true,\"key\":\"%s\",\"actors\":[%d,%d]}\n", argv[2], actors[0], actors[1]); fflush(stdout);
    struct recovery r = { .owner = { .root_fd = -1, .lock_fd = -1, .state_fd = -1, .temp_fd = -1 },
        .namespace_fd = -1, .authority_fd = -1, .generation_fd = -1, .attempt_fd = -1, .queue = -1,
        .disk.fd = -1, .settings.fd = -1, .components.fd = -1 };
    strcpy(r.owner.key, argv[2]);
    snprintf(r.owner.lock_name, sizeof(r.owner.lock_name), "%s.lock", argv[2]);
    snprintf(r.owner.state_name, sizeof(r.owner.state_name), "%s.state", argv[2]);
    snprintf(r.owner.temp_name, sizeof(r.owner.temp_name), "%s.next", argv[2]);
    recovery_sha("scripted-stage-diagnostic", 25U, r.source_digest);
    strcpy(r.boot, "00000000-0000-0000-0000-000000000001");
    struct coordinator_failure f = {0}; assert(coordinator_open(&r.owner, MODE_INITIALIZE, &f));
    char executable[PROC_PIDPATHINFO_MAXSIZE]; assert(proc_pidpath(getpid(), executable, sizeof(executable)) > 0);
    int image = open(executable, O_RDONLY | O_CLOEXEC); assert(image >= 0);
    assert(recovery_hash_fd(image, 32U * 1024U * 1024U, r.executable_digest, &f)); close(image);
    const char raw[] = "{\"diagnosticOnlyCanonical\":true}"; char raw_sha[65];
    assert(coordinator_commit(&r.owner, raw, sizeof(raw) - 1U, raw_sha, &f));
    char frame[148U + sizeof(raw) - 1U];
    snprintf(frame, 149U, "AGENAI-SNAPSHOT-1\n%s\n%s\n", argv[2], raw_sha); memcpy(frame + 148U, raw, sizeof(raw) - 1U);
    char frame_sha[65]; recovery_sha(frame, sizeof(frame), frame_sha);
    char *authority = "00000000-0000-4000-8000-000000000001", *generation = "00000000-0000-4000-8000-000000000002";
    char *origin[] = { authority, generation, r.source_digest, frame_sha, raw_sha };
    struct json reply; json_init(&reply);
    if (!recovery_bind_origin(&r, origin, &reply, &f)) { fprintf(stderr, "origin refusal: %s (%d)\n", f.reason, f.error); assert(false); }
    json_free(&reply);
    char *binding[] = { authority, generation, r.source_digest, "1", frame_sha, raw_sha, "none", "0", "0000000000000000000000000000000000000000000000000000000000000000" };
    json_init(&reply); assert(recovery_bind_attempt(&r, binding, &reply, &f)); json_free(&reply);
    json_init(&reply); assert(!recovery_arm(&r, &reply, &f)); assert(strcmp(f.reason, "scripted_state_read") == 0); json_free(&reply);
    assert(!r.pending_fact.body && !r.observation_failure.reason && log_arm_calls == 1U && r.queue >= 0);
    uint64_t original_clock = r.armed_at; int original_queue = r.queue;
    if (auxiliary_case) { actor_count = 3U; spawn_actors(2U, actor_count); }
    int ready[2], original_stdin = dup(STDIN_FILENO); assert(original_stdin >= 0 && pipe(ready) == 0);
    assert(dup2(ready[0], STDIN_FILENO) >= 0 && write(ready[1], "x", 1U) == 1);
    f = (struct coordinator_failure){0}; assert(recovery_wait_input(&r, &f)); assert(log_check_calls > 0U);
    assert(dup2(original_stdin, STDIN_FILENO) >= 0); close(original_stdin); close(ready[0]); close(ready[1]);
    f = (struct coordinator_failure){0}; json_init(&reply);
    if (exec_case) {
        assert(write(gates[0], "x", 1U) == 1);
        for (unsigned i = 0; i < 200U && !r.observation_failure.reason; i++) {
            (void)recovery_events(&r, &f); usleep(1000U);
        }
        assert(r.observation_failure.reason && strcmp(r.observation_failure.reason, "producer_exec") == 0);
        f = (struct coordinator_failure){0}; bool ok = recovery_arm(&r, &reply, &f);
        printf("{\"diagnosticRetryOk\":%s,\"nativeReply\":%s,\"failure\":\"%s\"}\n", ok ? "true" : "false", reply.length ? reply.data : "null", f.reason ? f.reason : "none"); fflush(stdout);
        assert(!ok); assert(strcmp(f.reason, "producer_exec") == 0);
    } else {
        assert(recovery_arm(&r, &reply, &f));
        printf("{\"diagnosticRetryOk\":true,\"nativeReply\":%s}\n", reply.data); fflush(stdout);
        assert(strstr(reply.data, "\"kind\":\"receipt\"") && strstr(reply.data, "\"recordKind\":\"armed\""));
        assert(r.phase == OBS_ARMED && strcmp(r.last_kind, "armed") == 0);
    }
    if (auxiliary_case) {
        assert(r.process_count == 3U && r.processes[2].pid == actors[2] && r.processes[2].auxiliary);
        assert(write(gates[2], "s", 1U) == 1);
        for (unsigned i = 0; i < 200U && r.processes[2].image != 9U; i++) {
            assert(recovery_events(&r, &f)); usleep(1000U);
        }
        assert(r.processes[2].image == 9U && !r.processes[2].exited && !r.observation_failure.reason);
        for (size_t i = 0; i < actor_count; i++) assert(kill(actors[i], SIGKILL) == 0);
        for (unsigned i = 0; i < 200U && !(r.processes[0].exited && r.processes[1].exited && r.processes[2].exited); i++) {
            assert(recovery_events(&r, &f)); usleep(1000U);
        }
        struct json stopped; json_init(&stopped); assert(recovery_stopped(&r, &stopped, &f));
        assert(r.phase == OBS_STOPPED && strstr(stopped.data, "\"recordKind\":\"stopped\""));
        printf("{\"diagnosticStopped\":true,\"nativeReply\":%s}\n", stopped.data); json_free(&stopped);
    }
    assert(r.armed_at == original_clock && r.queue == original_queue && log_arm_calls == 1U);
    assert(r.logs[0].initial == 8U && r.logs[1].initial == 8U && r.logs[0].cursor == 8U && r.logs[1].cursor == 8U);
    json_free(&reply); f = (struct coordinator_failure){0}; json_init(&reply);
    assert(recovery_abandon(&r, "abandoned", &reply, &f)); assert(r.phase == OBS_ENDED); json_free(&reply);
    join_actors(); recovery_close(&r);
    printf("{\"scope\":\"scripted-stage-storage-with-real-owned-watches\",\"case\":\"%s\",\"key\":\"%s\",\"actors\":[", argv[1], argv[2]);
    for (size_t i = 0; i < actor_count; i++) printf("%s%d", i ? "," : "", actors[i]);
    printf("],\"logArmCalls\":%u,\"logCheckCalls\":%u,\"clockAndOffsetsPreserved\":true,\"actorsJoined\":true}\n", log_arm_calls, log_check_calls);
    return 0;
}
