#include "recovery.h"
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <unistd.h>

#if !defined(__APPLE__) || !defined(__aarch64__)
#error "The recovery observer requires native Darwin arm64."
#endif
#ifndef AGENAI_RECOVERY_SOURCE_DIGEST
#error "The packaged fixed asset source digest is required."
#endif
_Static_assert(sizeof(AGENAI_RECOVERY_SOURCE_DIGEST) == 65U, "prepared source digest length");

static void failure_reply(struct recovery *r, const struct coordinator_failure *f, bool canonical) {
    bool lost = f->lost || !r->owner.claimed;
    if (lost) recovery_close(r); else if (canonical) r->owner.fenced = true;
    printf("{\"kind\":\"failure\",\"reason\":\"%s\",\"errno\":%d,\"claim\":\"%s\"}\n", f->reason ? f->reason : "operation_failed", f->error, lost ? "lost" : "held"); fflush(stdout);
}
static void state_identity(struct json *j, struct recovery *r) { json_raw(j, "\"stateDevice\":\"%llu\",\"stateInode\":\"%llu\"", (unsigned long long)r->owner.state_identity.st_dev, (unsigned long long)r->owner.state_identity.st_ino); }
static void opened(struct recovery *r) {
    struct json j; json_init(&j);
    json_raw(&j, "{\"kind\":\"opened\",\"initial\":\"existing\",\"rootDevice\":\"%llu\",\"rootInode\":\"%llu\",\"lockDevice\":\"%llu\",\"lockInode\":\"%llu\",",
        (unsigned long long)r->owner.root_identity.st_dev, (unsigned long long)r->owner.root_identity.st_ino, (unsigned long long)r->owner.lock_identity.st_dev, (unsigned long long)r->owner.lock_identity.st_ino);
    state_identity(&j, r); json_raw(&j, ",\"pendingTemp\":%s}", r->owner.temp_present ? "true" : "false"); recovery_reply(&j); json_free(&j);
}
static int read_command(char line[513], char *args[12], struct coordinator_failure *f) {
    size_t n = 0;
    for (;;) { int c = getchar(); if (c == EOF && n == 0 && feof(stdin)) return 0;
        if (c == EOF || (c != '\n' && (c < 32 || c > 126)) || n == 512U) { recovery_fail(f, "command_framing"); return -1; }
        if (c == '\n') break; line[n++] = (char)c; }
    if (!n || line[0] == ' ' || line[n - 1U] == ' ') { recovery_fail(f, "command_framing"); return -1; }
    line[n] = 0; int count = 1; args[0] = line;
    for (size_t i = 0; i < n; i++) if (line[i] == ' ') {
        if (count == 12 || line[i + 1U] == ' ') { recovery_fail(f, "command_framing"); return -1; }
        line[i] = 0; args[count++] = line + i + 1U;
    }
    return count;
}
static bool dispatch(struct recovery *r, int count, char **a, struct json *j, bool *closed, struct coordinator_failure *f) {
    if (count == 1 && strcmp(a[0], "CLOSE") == 0) { *closed = true; json_raw(j, "{\"kind\":\"closed\"}"); return true; }
    if (count == 1 && strcmp(a[0], "READ") == 0) {
        char *body = NULL, sha[65]; size_t n;
        if (!coordinator_read(&r->owner, &body, &n, sha, f)) return false;
        json_raw(j, "{\"kind\":\"snapshot\",\"digest\":\"%s\",", sha); state_identity(j, r);
        json_raw(j, ",\"pendingTemp\":%s,\"text\":", r->owner.temp_present ? "true" : "false"); json_string(j, body, n); json_raw(j, "}"); free(body); return true;
    }
    if (count == 1 && strcmp(a[0], "CHECK") == 0) { if (!coordinator_check(&r->owner, f)) return false; json_raw(j, "{\"kind\":\"checked\",\"fenced\":%s}", r->owner.fenced ? "true" : "false"); return true; }
    if (count == 1 && strcmp(a[0], "CLEANUP") == 0) { if (!coordinator_check(&r->owner, f)) return false; r->owner.cleanup = true; json_raw(j, "{\"kind\":\"cleanup\"}"); return true; }
    if (count == 1 && strcmp(a[0], "DISCARD_TEMP") == 0) { if (!coordinator_discard_temp(&r->owner, f)) return false; json_raw(j, "{\"kind\":\"discarded\"}"); return true; }
    if (count == 2 && strcmp(a[0], "COMMIT") == 0) {
        uint64_t size; if (!recovery_decimal(a[1], &size, true) || size > COORDINATOR_MAX_PAYLOAD) return recovery_fail(f, "commit_bound");
        char *body = NULL; if (!recovery_read_payload((size_t)size, &body, f)) return false;
        char sha[65]; bool ok = coordinator_commit(&r->owner, body, (size_t)size, sha, f); free(body);
        if (ok) { json_raw(j, "{\"kind\":\"committed\",\"digest\":\"%s\",", sha); state_identity(j, r); json_raw(j, "}"); } return ok;
    }
    if (count == 6 && strcmp(a[0], "BIND_ORIGIN") == 0) return recovery_bind_origin(r, a + 1, j, f);
    if (count == 4 && strcmp(a[0], "BIND_EXISTING") == 0) return recovery_bind_existing(r, a + 1, j, f);
    if (count == 10 && strcmp(a[0], "BIND") == 0) return recovery_bind_attempt(r, a + 1, j, f);
    if (count == 1 && (strcmp(a[0], "OBSERVE_ADMISSION") == 0 || strcmp(a[0], "OBSERVE_CURRENT_PEER") == 0)) {
        json_raw(j, "{\"kind\":\"%s\",\"facts\":", strcmp(a[0], "OBSERVE_ADMISSION") == 0 ? "admission" : "current_peer");
        if (!recovery_admission(r, j, f)) return false; json_raw(j, "}"); return true;
    }
    if (count == 1 && strcmp(a[0], "ARM") == 0) return recovery_arm(r, j, f);
    if (count == 1 && strcmp(a[0], "OBSERVE_STOPPED") == 0) return recovery_stopped(r, j, f);
    if (count == 1 && strcmp(a[0], "FINISH_FACTS") == 0) return recovery_finish(r, j, f);
    if (count == 1 && strcmp(a[0], "ABANDON") == 0) return recovery_abandon(r, "abandoned", j, f);
    if (count == 2 && strcmp(a[0], "READ_LOG") == 0) return coordinator_check(&r->owner, f) && recovery_log_read(r, a[1], j, f);
    if (count == 2 && strcmp(a[0], "READ_METADATA") == 0) return coordinator_check(&r->owner, f) && recovery_metadata(r, a[1], j, f);
    if (count == 2 && strcmp(a[0], "ARCHIVE") == 0) return r->origin_ready ? recovery_archive(r, a[1], j, f) : recovery_fail(f, "generation_unbound");
    if (count == 3 && strcmp(a[0], "READ_RECEIPT") == 0) return recovery_read_receipt(r, a[1], a[2], j, f);
    if (count == 4 && strcmp(a[0], "SDK_DECISION") == 0) {
        uint64_t n; if (!recovery_decimal(a[3], &n, true) || n > RECOVERY_RECEIPT_MAX - 512U) return recovery_fail(f, "decision_bound");
        char *body = NULL; if (!recovery_read_payload((size_t)n, &body, f)) return false;
        bool ok = recovery_sdk_decision(r, a[1], a[2], body, (size_t)n, j, f); free(body); return ok;
    }
    return recovery_fail(f, "command_unknown");
}
int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN); umask(077); setvbuf(stdin, NULL, _IONBF, 0);
    struct recovery r = { .owner = { .root_fd = -1, .lock_fd = -1, .state_fd = -1, .temp_fd = -1 },
        .namespace_fd = -1, .authority_fd = -1, .generation_fd = -1, .attempt_fd = -1, .queue = -1,
        .disk.fd = -1, .settings.fd = -1, .components.fd = -1 };
    struct coordinator_failure failure = {0};
    if (getuid() != geteuid() || getgid() != getegid() || argc != 5 || strcmp(argv[1], "--cleanup") != 0 || !recovery_hex(argv[2]) || strcmp(argv[3], "--endpoint") != 0
        || argv[4][0] != '/' || strlen(argv[4]) >= sizeof(r.endpoint)) return 64;
    strcpy(r.owner.key, argv[2]); strcpy(r.endpoint, argv[4]); strcpy(r.source_digest, AGENAI_RECOVERY_SOURCE_DIGEST);
    snprintf(r.owner.lock_name, sizeof(r.owner.lock_name), "%s.lock", r.owner.key);
    snprintf(r.owner.state_name, sizeof(r.owner.state_name), "%s.state", r.owner.key);
    snprintf(r.owner.temp_name, sizeof(r.owner.temp_name), "%s.next", r.owner.key);
    if (!recovery_hex(r.source_digest)) return 64;
    size_t boot_size = sizeof(r.boot);
    if (sysctlbyname("kern.bootsessionuuid", r.boot, &boot_size, NULL, 0) < 0) return 70;
    for (size_t i = 0; i < strlen(r.boot); i++) if (r.boot[i] >= 'A' && r.boot[i] <= 'F') r.boot[i] = (char)(r.boot[i] + ('a' - 'A'));
    char executable[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath(getpid(), executable, sizeof(executable)) <= 0) return 70;
    struct file_fact self = { .fd = -1 };
    if (!recovery_file_open(executable, &self, false, &failure) || !recovery_hash_fd(self.fd, 32U * 1024U * 1024U, r.executable_digest, &failure)) { if (self.fd >= 0) close(self.fd); return 70; }
    close(self.fd);
    if (!coordinator_open(&r.owner, MODE_CLEANUP, &failure)) { failure_reply(&r, &failure, true); recovery_close(&r); return 1; }
    opened(&r);
    for (;;) {
        char line[513], *args[12]; failure = (struct coordinator_failure){0};
        if (!recovery_wait_input(&r, &failure)) { failure_reply(&r, &failure, false); break; }
        int count = read_command(line, args, &failure);
        if (count <= 0) { if (count < 0) failure_reply(&r, &failure, true); break; }
        struct json reply; json_init(&reply); bool closed = false;
        bool ok = dispatch(&r, count, args, &reply, &closed, &failure);
        if (ok && !reply.valid) { ok = false; recovery_fail(&failure, "response_bound"); }
        if (ok) recovery_reply(&reply);
        else {
            bool canonical = strcmp(args[0], "READ") == 0 || strcmp(args[0], "CHECK") == 0
                || strcmp(args[0], "COMMIT") == 0 || strcmp(args[0], "DISCARD_TEMP") == 0;
            failure_reply(&r, &failure, canonical);
        }
        json_free(&reply); if (closed || !r.owner.claimed) break;
    }
    if (r.owner.claimed && r.attempt && (r.pending_fact.body || recovery_observing(&r) || r.phase == OBS_FINISHED)) {
        struct json ignored; json_init(&ignored); failure = (struct coordinator_failure){0}; recovery_abandon(&r, "interrupted", &ignored, &failure); json_free(&ignored);
    }
    recovery_close(&r); return 0;
}
