#include "recovery.h"
#include "profile.h"
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#ifndef AGENAI_RECOVERY_PROFILE_DIGEST
#error "The fixed profile source digest must be supplied by offline preparation."
#endif
_Static_assert(sizeof(AGENAI_RECOVERY_PROFILE_DIGEST) == 65U, "fixed profile digest length");

static bool same_process(const struct process_fact *a, const struct process_fact *b) {
    return a->pid == b->pid && a->uid == b->uid && a->seconds == b->seconds && a->microseconds == b->microseconds;
}
static bool producer_roles(const struct process_fact *p, size_t n) {
    bool backend = false, vm = false;
    for (size_t i = 0; i < n; i++) { const char *role = recovery_images[p[i].image].role;
        if (strcmp(role, "backend") == 0) backend = true; if (strcmp(role, "virtualization") == 0) vm = true; }
    return backend && vm;
}
static bool same_census(const struct process_fact *left, size_t ln, const struct process_fact *right, size_t rn) {
    if (ln != rn) return false;
    for (size_t i = 0; i < ln; i++) {
        bool found = false;
        for (size_t j = 0; j < rn; j++) if (same_process(&left[i], &right[j]) && left[i].image == right[j].image) found = true;
        if (!found) return false;
    }
    return true;
}
bool recovery_observing(const struct recovery *r) {
    return r->phase == OBS_ARMING || r->phase == OBS_ARMED || r->phase == OBS_STOPPED;
}
bool recovery_observation_result(struct recovery *r, bool success, const struct coordinator_failure *f) {
    if (!success && f->reason && !r->observation_failure.reason && recovery_observing(r)) r->observation_failure = *f;
    return success;
}
static bool admission_observe(struct recovery *r, struct json *j, struct coordinator_failure *f) {
    struct process_fact processes[RECOVERY_PROCESS_MAX]; size_t count;
    if (!recovery_processes(r, processes, &count, CENSUS_CURRENT, f)) return false;
    if (!producer_roles(processes, count)) return recovery_fail(f, "producer_roles_missing");
    json_raw(j, "{\"profileDigest\":\"%s\",\"hostBoot\":\"%s\",\"uid\":%u,\"continuousNs\":\"%llu\",\"images\":[",
        AGENAI_RECOVERY_PROFILE_DIGEST, r->boot, getuid(), (unsigned long long)recovery_now() * 1000000ULL);
    for (size_t i = 0; i < recovery_image_count; i++) {
        if (i) json_raw(j, ","); if (!recovery_code(r, i, 0, j, f)) return false;
    }
    json_raw(j, "],\"processes\":[");
    for (size_t i = 0; i < count; i++) { if (i) json_raw(j, ","); recovery_process_json(j, &processes[i]); }
    json_raw(j, "],\"peer\":"); if (!recovery_peer(r, j, f)) return false;
    json_raw(j, ","); if (!recovery_files_admission(r, j, f)) return false; json_raw(j, "}");
    struct process_fact after[RECOVERY_PROCESS_MAX]; size_t after_count;
    if (!recovery_processes(r, after, &after_count, CENSUS_CURRENT, f)) return false;
    if (!same_census(processes, count, after, after_count)) return recovery_fail(f, "admission_composition_changed");
    if (r->phase == OBS_IDLE && !r->pending_fact.body && !*r->last_kind) {
        memcpy(r->admitted_processes, processes, count * sizeof(*processes)); r->admitted_count = count;
    }
    return true;
}
bool recovery_admission(struct recovery *r, struct json *j, struct coordinator_failure *f) {
    if (!coordinator_check(&r->owner, f)) return false;
    if (!recovery_observation_result(r, admission_observe(r, j, f), f)) return false;
    return coordinator_check(&r->owner, f);
}
static bool fact_start(struct recovery *r, const char *kind, struct json *j, struct coordinator_failure *f) {
    char *canonical = NULL, sha[65]; size_t n;
    if (!recovery_store_check(r, f) || r->attempt == 0) return recovery_fail(f, "attempt_unbound");
    if (!coordinator_read(&r->owner, &canonical, &n, sha, f)) return false; free(canonical);
    json_raw(j, "{\"format\":\"agenai.desktop-recovery-native-fact.v1\",\"engineKey\":\"%s\",\"authorityId\":\"%s\",\"generationId\":\"%s\",\"recoveryKey\":\"%s\",\"attempt\":%llu,\"originFrameDigest\":\"%s\",\"canonicalPayloadSha256\":\"%s\",\"claim\":{\"rootDevice\":\"%llu\",\"rootInode\":\"%llu\",\"lockDevice\":\"%llu\",\"lockInode\":\"%llu\"},\"previousHistory\":",
        r->owner.key, r->authority, r->generation, r->recovery_key, (unsigned long long)r->attempt, r->origin_frame, sha,
        (unsigned long long)r->owner.root_identity.st_dev, (unsigned long long)r->owner.root_identity.st_ino,
        (unsigned long long)r->owner.lock_identity.st_dev, (unsigned long long)r->owner.lock_identity.st_ino);
    if (strcmp(r->previous_kind, "none") == 0) json_raw(j, "{\"kind\":\"none\"}");
    else json_raw(j, "{\"kind\":\"%s\",\"attempt\":%llu,\"sha256\":\"%s\"}", r->previous_kind, (unsigned long long)r->previous_attempt, r->previous_digest);
    json_raw(j, ",\"previous\":");
    if (!*r->last_kind) json_raw(j, "null");
    else json_raw(j, "{\"kind\":\"%s\",\"attempt\":%llu,\"sha256\":\"%s\"}", r->last_kind, (unsigned long long)r->attempt, r->last_digest);
    json_raw(j, ",\"issuer\":{\"sourceDigest\":\"%s\",\"executableSha256\":\"%s\"},\"profileDigest\":\"%s\",\"hostBoot\":\"%s\",\"uid\":%u,\"startedContinuousNs\":\"%llu\",\"finishedContinuousNs\":\"%llu\",\"kind\":\"%s\",",
        r->source_digest, r->executable_digest, AGENAI_RECOVERY_PROFILE_DIGEST, r->boot, getuid(),
        (unsigned long long)r->armed_at * 1000000ULL, (unsigned long long)recovery_now() * 1000000ULL, kind);
    return true;
}
static bool reconcile_fact(struct recovery *r, struct json *reply, struct coordinator_failure *f) {
    struct pending_native_fact *pending = &r->pending_fact;
    char scope[24]; snprintf(scope, sizeof(scope), "%llu", (unsigned long long)r->attempt);
    char digest[65];
    bool ok = recovery_publish(r, pending->kind, scope, pending->body, pending->length, reply, digest, f);
    if (!ok || !reply->valid) {
        if (ok) { errno = ENOMEM; coordinator_error(f, "fact_reply_allocation", false); }
        return false;
    }
    strcpy(r->last_kind, pending->kind); strcpy(r->last_digest, digest);
    r->last_bytes = 512U + pending->length; r->phase = pending->target;
    free(pending->body); *pending = (struct pending_native_fact){0}; return true;
}
static bool fact_publish(struct recovery *r, const char *kind, enum observation_phase target,
    struct json *body, struct json *reply, struct coordinator_failure *f) {
    if (r->pending_fact.body) return recovery_fail(f, "native_publication_pending");
    json_raw(body, "}");
    if (!body->valid || body->length > RECOVERY_RECEIPT_MAX - 512U) return recovery_fail(f, "fact_bound");
    r->pending_fact = (struct pending_native_fact){ .kind = kind, .body = body->data, .length = body->length, .target = target };
    *body = (struct json){ .valid = true };
    return reconcile_fact(r, reply, f);
}
static bool watch_process(struct recovery *r, const struct process_fact *p, struct coordinator_failure *f) {
    struct kevent event;
    EV_SET(&event, (uintptr_t)p->pid, EVFILT_PROC, EV_ADD | EV_CLEAR, NOTE_EXIT | NOTE_EXEC | NOTE_FORK, 0, NULL);
    if (kevent(r->queue, &event, 1, NULL, 0, NULL) < 0) return coordinator_error(f, "producer_watch", false);
    struct proc_bsdinfo current;
    if (proc_pidinfo(p->pid, PROC_PIDTBSDINFO, 0, &current, sizeof(current)) != sizeof(current)
        || current.pbi_start_tvsec != p->seconds || current.pbi_start_tvusec != p->microseconds || current.pbi_uid != p->uid)
        return recovery_fail(f, "producer_watch_lifetime");
    return true;
}
static bool watch_auxiliary(struct recovery *r, const struct process_fact *p, bool *added, struct coordinator_failure *f) {
    *added = false;
    if (r->process_count == RECOVERY_PROCESS_MAX) return recovery_fail(f, "producer_lifetime_bound");
    struct kevent event;
    EV_SET(&event, (uintptr_t)p->pid, EVFILT_PROC, EV_ADD | EV_CLEAR, NOTE_EXIT | NOTE_EXEC | NOTE_FORK, 0, NULL);
    if (kevent(r->queue, &event, 1, NULL, 0, NULL) < 0) {
        if (errno != ESRCH) return coordinator_error(f, "producer_watch", false);
        struct process_fact current;
        enum process_observation state = recovery_process(r, p->pid, &current, CENSUS_OBSERVING, f);
        return state == PROCESS_ABSENT ? true : state == PROCESS_INVALID ? false : recovery_fail(f, "producer_watch_lifetime");
    }
    struct process_fact *watched = &r->processes[r->process_count++]; *watched = *p; watched->auxiliary = true;
    *added = true;
    struct process_fact current;
    enum process_observation state = recovery_process(r, p->pid, &current, CENSUS_OBSERVING, f);
    if (state == PROCESS_ABSENT) return true; // Its installed watch still owes an actual NOTE_EXIT.
    if (state == PROCESS_INVALID) return false;
    if (state != PROCESS_VALIDATED || !same_process(watched, &current)) return recovery_fail(f, "producer_watch_lifetime");
    watched->image = current.image; return true;
}
static bool events_observe(struct recovery *r, struct coordinator_failure *f) {
    if (!recovery_observing(r)) return true;
    if (r->observation_failure.reason) { *f = r->observation_failure; return false; }
    if (recovery_now() - r->armed_at > RECOVERY_ATTEMPT_MS) return recovery_fail(f, "observation_expired");
    for (unsigned pass = 0; pass < RECOVERY_EPOCH_RETRIES; pass++) {
        bool changed = false, recapture[RECOVERY_PROCESS_MAX] = {0};
        for (unsigned batch = 0;; batch++) {
            if (batch == RECOVERY_EPOCH_RETRIES) return recovery_fail(f, "producer_event_bound");
            struct kevent events[RECOVERY_PROCESS_MAX]; struct timespec immediate = {0}; int count;
            do { count = kevent(r->queue, NULL, 0, events, RECOVERY_PROCESS_MAX, &immediate); } while (count < 0 && errno == EINTR);
            if (count < 0) return coordinator_error(f, "producer_event_read", false);
            for (int i = 0; i < count; i++) {
                if ((events[i].flags & EV_ERROR) != 0) return recovery_fail(f, "producer_event_error");
                if (events[i].filter == EVFILT_VNODE) {
                    if ((events[i].fflags & NOTE_REVOKE) != 0) return recovery_fail(f, "log_coverage_lost");
                    continue;
                }
                if (events[i].filter != EVFILT_PROC) return recovery_fail(f, "producer_event_filter");
                bool known = false;
                for (size_t p = 0; p < r->process_count; p++) if (!r->processes[p].exited && (uintptr_t)r->processes[p].pid == events[i].ident) {
                    known = true; r->processes[p].events |= events[i].fflags;
                    if ((events[i].fflags & NOTE_EXEC) != 0) {
                        if (!r->processes[p].auxiliary) return recovery_fail(f, "producer_exec");
                        recapture[p] = true;
                    }
                    if ((events[i].fflags & NOTE_EXIT) != 0) r->processes[p].exited = true;
                    if ((events[i].fflags & (NOTE_FORK | NOTE_EXEC | NOTE_EXIT)) != 0) changed = true;
                }
                if (!known) return recovery_fail(f, "producer_event_unknown");
            }
            if (count < (int)RECOVERY_PROCESS_MAX) break;
        }
        for (size_t p = 0; p < r->process_count; p++) if (recapture[p] && !r->processes[p].exited) {
            struct process_fact current;
            enum process_observation state = recovery_process(r, r->processes[p].pid, &current, CENSUS_OBSERVING, f);
            if (state == PROCESS_ABSENT) continue; // Do not invent a code validation or a kernel exit.
            if (state == PROCESS_INVALID) return false;
            if (state != PROCESS_VALIDATED || !same_process(&current, &r->processes[p])) return recovery_fail(f, "producer_epoch_identity");
            r->processes[p].image = current.image;
        }
        if (r->phase != OBS_STOPPED) {
            struct process_fact current[RECOVERY_PROCESS_MAX]; size_t count;
            if (!recovery_processes(r, current, &count, CENSUS_OBSERVING, f)) return false;
            for (size_t i = 0; i < count; i++) {
                bool known = false;
                for (size_t p = 0; p < r->process_count; p++) if (same_process(&current[i], &r->processes[p])) {
                    known = true;
                    if (r->processes[p].exited) return recovery_fail(f, "producer_returned");
                    if (current[i].image != r->processes[p].image && !r->processes[p].auxiliary) return recovery_fail(f, "producer_exec");
                }
                if (!known) {
                    bool added;
                    if (!watch_auxiliary(r, &current[i], &added, f)) return false;
                    changed = changed || added;
                }
            }
        }
        if (!changed) return true;
    }
    return recovery_fail(f, "producer_reconciliation_bound");
}
bool recovery_events(struct recovery *r, struct coordinator_failure *f) {
    return recovery_observation_result(r, events_observe(r, f), f);
}
bool recovery_wait_input(struct recovery *r, struct coordinator_failure *f) {
    for (;;) {
        bool observing = recovery_observing(r) && !r->observation_failure.reason;
        struct pollfd descriptors[] = { { .fd = STDIN_FILENO, .events = POLLIN }, { .fd = observing ? r->queue : -1, .events = POLLIN } };
        int result = poll(descriptors, 2U, observing ? 200 : -1);
        if (result < 0 && errno == EINTR) continue;
        if (result < 0) return coordinator_error(f, "input_poll", false);
        if (observing) {
            struct coordinator_failure observation = {0};
            (void)(recovery_events(r, &observation) && recovery_logs_check(r, &observation));
        }
        if (descriptors[0].revents & (POLLIN | POLLHUP)) return true;
        if (descriptors[0].revents & (POLLERR | POLLNVAL)) return recovery_fail(f, "input_poll");
    }
}
static bool armed_fact(struct recovery *r, struct json *j, struct coordinator_failure *f) {
    if (!recovery_events(r, f)) return false;
    struct json body; json_init(&body); bool ok = fact_start(r, "armed", &body, f);
    if (ok) {
        json_raw(&body, "\"producers\":["); size_t originals = 0;
        for (size_t i = 0; i < r->process_count; i++) if (!r->processes[i].auxiliary) {
            if (originals) json_raw(&body, ","); recovery_process_json(&body, &r->processes[i]); originals++;
        }
        json_raw(&body, "],\"watchCount\":%zu,\"deadlineContinuousNs\":\"%llu\",\"logSources\":[", originals, (unsigned long long)(r->armed_at + RECOVERY_ATTEMPT_MS) * 1000000ULL);
        for (size_t i = 0; i < r->log_count; i++) {
            const struct log_file *log = &r->logs[i]; if (i) json_raw(&body, ",");
            json_raw(&body, "{\"source\":\"%s\",\"sourceIdentity\":\"%llu:%llu\",\"initialOffset\":\"%llu\"}", log->source == 0 ? "init" : "console",
                (unsigned long long)log->file.identity.st_dev, (unsigned long long)log->file.identity.st_ino, (unsigned long long)log->initial);
        }
        json_raw(&body, "]");
        ok = fact_publish(r, "armed", OBS_ARMED, &body, j, f);
    }
    json_free(&body); return ok;
}
bool recovery_arm(struct recovery *r, struct json *j, struct coordinator_failure *f) {
    char scope[24]; snprintf(scope, sizeof(scope), "%llu", (unsigned long long)r->attempt);
    if (r->pending_fact.body) {
        if (strcmp(r->pending_fact.kind, "armed") == 0) return reconcile_fact(r, j, f);
        if (strcmp(r->pending_fact.kind, "admission") != 0) return recovery_fail(f, "native_publication_pending");
        struct json ignored; json_init(&ignored); bool ok = reconcile_fact(r, &ignored, f); json_free(&ignored);
        if (!ok) return false;
    }
    if (r->phase == OBS_ARMED) return recovery_read_receipt(r, "armed", scope, j, f);
    if (r->phase == OBS_ARMING) return armed_fact(r, j, f);
    if (r->phase != OBS_IDLE || r->attempt_fd < 0) return recovery_fail(f, "observation_phase");
    if (strcmp(r->last_kind, "admission") != 0) {
        struct stat exists;
        if (fstatat(r->attempt_fd, "admission.json", &exists, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT)
            return recovery_fail(f, "attempt_already_entered");
        if (!recovery_reserve_attempt(r, f)) return false;
        r->armed_at = recovery_now();
        struct json body, admission, ignored; json_init(&body); json_init(&admission); json_init(&ignored);
        bool ok = recovery_admission(r, &admission, f) && fact_start(r, "admission", &body, f);
        if (ok) { json_raw(&body, "\"facts\":%s", admission.data); ok = fact_publish(r, "admission", OBS_IDLE, &body, &ignored, f); }
        json_free(&body); json_free(&admission); json_free(&ignored);
        if (!ok) return false;
    }
    if (r->observation_failure.reason) { *f = r->observation_failure; return false; }
    if (recovery_now() - r->armed_at > RECOVERY_ATTEMPT_MS) return recovery_fail(f, "observation_expired");
    if (!recovery_processes(r, r->processes, &r->process_count, CENSUS_CURRENT, f) || !producer_roles(r->processes, r->process_count)) return recovery_fail(f, "producer_roles_missing");
    if (!same_census(r->admitted_processes, r->admitted_count, r->processes, r->process_count)) return recovery_fail(f, "producer_admission_race");
    if (r->queue >= 0) close(r->queue);
    r->queue = kqueue(); if (r->queue < 0) return coordinator_error(f, "producer_queue", false);
    for (size_t i = 0; i < r->process_count; i++) if (!watch_process(r, &r->processes[i], f)) return false;
    if (!recovery_logs_arm(r, f)) return false;
    struct process_fact second[RECOVERY_PROCESS_MAX]; size_t count;
    if (!recovery_processes(r, second, &count, CENSUS_CURRENT, f)) return false;
    for (size_t i = 0; i < count; i++) {
        bool found = false; for (size_t p = 0; p < r->process_count; p++) if (same_process(&second[i], &r->processes[p])) found = true;
        if (!found) return recovery_fail(f, "producer_arm_race");
    }
    r->phase = OBS_ARMING;
    return armed_fact(r, j, f);
}
static bool endpoint_stopped(struct recovery *r, struct coordinator_failure *f) {
    struct sockaddr_un address = { .sun_family = AF_UNIX }; size_t n = strlen(r->endpoint);
    if (n >= sizeof(address.sun_path)) return recovery_fail(f, "endpoint_path_bound");
    memcpy(address.sun_path, r->endpoint, n + 1U); address.sun_len = (uint8_t)(offsetof(struct sockaddr_un, sun_path) + n + 1U);
    int fd = socket(AF_UNIX, SOCK_STREAM, 0); if (fd < 0) return coordinator_error(f, "stopped_socket", false);
    if (fcntl(fd, F_SETFL, O_NONBLOCK) < 0 || fcntl(fd, F_SETFD, FD_CLOEXEC) < 0) { close(fd); return coordinator_error(f, "stopped_socket_flags", false); }
    int result = connect(fd, (struct sockaddr *)&address, address.sun_len); int error = errno; close(fd);
    if (result == 0) return recovery_fail(f, "endpoint_still_serving");
    return error == ENOENT || error == ECONNREFUSED ? true : recovery_fail(f, "endpoint_stopped_unknown");
}
bool recovery_stopped(struct recovery *r, struct json *j, struct coordinator_failure *f) {
    char scope[24]; snprintf(scope, sizeof(scope), "%llu", (unsigned long long)r->attempt);
    if (r->pending_fact.body) return strcmp(r->pending_fact.kind, "stopped") == 0
        ? reconcile_fact(r, j, f) : recovery_fail(f, "native_publication_pending");
    if (r->phase == OBS_STOPPED) return recovery_read_receipt(r, "stopped", scope, j, f);
    if (r->phase != OBS_ARMED) return recovery_fail(f, "stopped_not_armed");
    if (!recovery_events(r, f)) return false;
    for (size_t i = 0; i < r->process_count; i++) if (!r->processes[i].exited)
        return recovery_observation_result(r, recovery_fail(f, "producer_exit_unobserved"), f);
    struct process_fact ignored[RECOVERY_PROCESS_MAX]; size_t n;
    for (unsigned pass = 0; pass < 2U; pass++) {
        if (!recovery_observation_result(r, recovery_processes(r, ignored, &n, CENSUS_STOPPED, f) && n == 0 && endpoint_stopped(r, f), f)) return false;
    }
    if (!recovery_logs_check(r, f) || !recovery_observation_result(r, recovery_file_check(&r->disk, f), f)) return false;
    struct json body; json_init(&body); bool ok = fact_start(r, "stopped", &body, f);
    if (ok) { json_raw(&body, "\"joined\":[");
        for (size_t i = 0; i < r->process_count; i++) { if (i) json_raw(&body, ","); recovery_process_json(&body, &r->processes[i]); }
        json_raw(&body, "],\"completeCensuses\":2,\"endpoint\":\"not_serving\""); ok = fact_publish(r, "stopped", OBS_STOPPED, &body, j, f); }
    json_free(&body); return ok;
}
static void spans_json(struct recovery *r, struct json *j) {
    json_raw(j, "[");
    for (size_t i = 0; i < r->span_count; i++) {
        const struct log_span *span = &r->spans[i]; const struct log_file *log = &r->logs[span->file];
        if (i) json_raw(j, ",");
        json_raw(j, "{\"source\":\"%s\",\"sourceIdentity\":\"%llu:%llu\",\"sequence\":%llu,\"start\":\"%llu\",\"end\":\"%llu\",\"sha256\":\"%s\"}",
            log->source == 0 ? "init" : "console", (unsigned long long)log->file.identity.st_dev, (unsigned long long)log->file.identity.st_ino,
            (unsigned long long)span->sequence, (unsigned long long)span->start, (unsigned long long)span->end, span->sha);
    }
    json_raw(j, "]");
}
bool recovery_finish(struct recovery *r, struct json *j, struct coordinator_failure *f) {
    char scope[24]; snprintf(scope, sizeof(scope), "%llu", (unsigned long long)r->attempt);
    if (r->pending_fact.body) return strcmp(r->pending_fact.kind, "finished") == 0
        ? reconcile_fact(r, j, f) : recovery_fail(f, "native_publication_pending");
    if (r->phase == OBS_FINISHED) return recovery_read_receipt(r, "finished", scope, j, f);
    if (r->phase != OBS_STOPPED) return recovery_fail(f, "finish_without_stopped");
    if (!recovery_events(r, f) || !recovery_logs_check(r, f)) return false;
    struct process_fact fresh[RECOVERY_PROCESS_MAX]; size_t count;
    if (!recovery_observation_result(r, recovery_processes(r, fresh, &count, CENSUS_CURRENT, f), f)) return false;
    if (!producer_roles(fresh, count)) return recovery_observation_result(r, recovery_fail(f, "fresh_producers_missing"), f);
    for (size_t p = 0; p < count; p++) for (size_t old = 0; old < r->process_count; old++) if (same_process(&fresh[p], &r->processes[old]))
        return recovery_observation_result(r, recovery_fail(f, "old_producer_returned"), f);
    struct json body, facts, spans; json_init(&body); json_init(&facts); json_init(&spans);
    bool ok = recovery_admission(r, &facts, f) && recovery_events(r, f) && recovery_logs_finish(r, f) && fact_start(r, "finished", &body, f);
    if (ok) { spans_json(r, &spans); char sha[65]; recovery_sha(spans.data, spans.length, sha);
        json_raw(&body, "\"facts\":%s,\"spans\":%s,\"spanManifestSha256\":\"%s\"", facts.data, spans.data, sha);
        ok = fact_publish(r, "finished", OBS_FINISHED, &body, j, f); }
    json_free(&body); json_free(&facts); json_free(&spans); return ok;
}
bool recovery_abandon(struct recovery *r, const char *outcome, struct json *j, struct coordinator_failure *f) {
    if (!r->attempt || r->attempt_fd < 0) return recovery_fail(f, "attempt_unbound");
    if (r->pending_fact.body) {
        if (strcmp(r->pending_fact.kind, "outcome") == 0) return reconcile_fact(r, j, f);
        struct json ignored; json_init(&ignored); bool ok = reconcile_fact(r, &ignored, f); json_free(&ignored);
        if (!ok) return false;
    }
    char scope[24]; snprintf(scope, sizeof(scope), "%llu", (unsigned long long)r->attempt);
    struct json existing; json_init(&existing);
    if (!recovery_read_receipt(r, "barrier_acceptance", scope, &existing, f)) { json_free(&existing); return false; }
    if (strncmp(existing.data, "{\"kind\":\"receipt\"", 17U) == 0) { json_raw(j, "%s", existing.data); json_free(&existing); r->phase = OBS_ENDED; return true; }
    json_free(&existing); json_init(&existing);
    if (!recovery_read_receipt(r, "outcome", scope, &existing, f)) { json_free(&existing); return false; }
    if (strncmp(existing.data, "{\"kind\":\"receipt\"", 17U) == 0) { json_raw(j, "%s", existing.data); json_free(&existing); r->phase = OBS_ENDED; return true; }
    json_free(&existing);
    struct json body; json_init(&body); bool ok = fact_start(r, "outcome", &body, f);
    if (ok) {
        json_raw(&body, "\"outcome\":\"%s\",\"reason\":\"%s\",\"lastCompleted\":", outcome, strcmp(outcome, "abandoned") == 0 ? "caller" : "transport");
        if (!*r->last_kind) json_raw(&body, "null"); else json_raw(&body, "{\"kind\":\"%s\",\"attempt\":%llu,\"sha256\":\"%s\"}", r->last_kind, (unsigned long long)r->attempt, r->last_digest);
        ok = fact_publish(r, "outcome", OBS_ENDED, &body, j, f);
    }
    json_free(&body); return ok;
}
void recovery_close(struct recovery *r) {
    free(r->pending_fact.body); r->pending_fact = (struct pending_native_fact){0};
    if (r->queue >= 0) close(r->queue); recovery_files_close(r); recovery_code_close(r);
    int *fds[] = { &r->attempt_fd, &r->generation_fd, &r->authority_fd, &r->namespace_fd };
    for (size_t i = 0; i < sizeof(fds) / sizeof(fds[0]); i++) if (*fds[i] >= 0) { close(*fds[i]); *fds[i] = -1; }
    coordinator_close(&r->owner);
}
