#ifndef AGENAI_DESKTOP_RECOVERY_H
#define AGENAI_DESKTOP_RECOVERY_H

#include "../coordinator/coordinator.h"
#include <stdint.h>
#include <stdio.h>
#include <sys/types.h>

#define RECOVERY_RECEIPT_MAX 262144U
#define RECOVERY_CHUNK 65536U
#define RECOVERY_PROCESS_MAX 128U
#define RECOVERY_IMAGE_MAX 32U
#define RECOVERY_LOG_MAX 64U
#define RECOVERY_SPAN_MAX 512U
#define RECOVERY_ATTEMPT_MS 600000U
#define RECOVERY_EPOCH_RETRIES 8U

struct json { char *data; size_t length, capacity; bool valid; };
struct image_profile { const char *relative, *role, *sha, *identifier; };
extern const struct image_profile recovery_images[];
extern const size_t recovery_image_count;

struct process_fact {
    pid_t pid, parent, group; uid_t uid; uint64_t seconds, microseconds;
    size_t image; bool exited, auxiliary; uint32_t events;
};
struct file_fact { int fd; struct stat identity; char path[4096]; };
struct code_cache { struct file_fact file; const void *code; bool valid; };
struct log_file {
    struct file_fact file; unsigned source; uint64_t cursor, initial;
    bool exhausted;
};
struct log_span { unsigned file; uint64_t sequence, start, end; char sha[65]; };
enum census_mode { CENSUS_CURRENT, CENSUS_OBSERVING, CENSUS_STOPPED };
enum code_observation { CODE_INVALID_INSTALLATION, CODE_INVALID_PROCESS, CODE_VALIDATED };
enum process_observation { PROCESS_INVALID, PROCESS_ABSENT, PROCESS_OTHER, PROCESS_VALIDATED };
enum observation_phase { OBS_IDLE, OBS_ARMING, OBS_ARMED, OBS_STOPPED, OBS_FINISHED, OBS_ENDED };
struct pending_native_fact {
    const char *kind;
    char *body;
    size_t length;
    enum observation_phase target;
};
struct recovery {
    struct coordinator owner;
    char endpoint[4096], boot[37], source_digest[65], executable_digest[65];
    int namespace_fd, authority_fd, generation_fd, attempt_fd, queue;
    struct stat namespace_identity, authority_identity, generation_identity, attempt_identity;
    char authority[37], generation[37], recovery_key[65], origin_frame[65], origin_raw[65];
    uint64_t attempt, armed_at, previous_attempt;
    char previous_kind[32], previous_digest[65], last_kind[24], last_digest[65];
    size_t last_bytes;
    enum observation_phase phase;
    struct process_fact processes[RECOVERY_PROCESS_MAX]; size_t process_count;
    struct process_fact admitted_processes[RECOVERY_PROCESS_MAX]; size_t admitted_count;
    struct code_cache images[RECOVERY_IMAGE_MAX];
    struct log_file logs[RECOVERY_LOG_MAX]; size_t log_count;
    struct log_span spans[RECOVERY_SPAN_MAX]; size_t span_count, observed_bytes;
    uint64_t chunk_sequence;
    struct file_fact disk, settings, components;
    bool bound, origin_ready;
    struct coordinator_failure observation_failure;
    struct pending_native_fact pending_fact;
};

void json_init(struct json *j);
void json_free(struct json *j);
void json_raw(struct json *j, const char *format, ...) __attribute__((format(printf, 2, 3)));
void json_string(struct json *j, const char *bytes, size_t length);
void json_base64(struct json *j, const unsigned char *bytes, size_t length);
void json_file_identity(struct json *j, const struct stat *value);
void recovery_sha(const void *bytes, size_t length, char sha[65]);
bool recovery_hash_fd(int fd, off_t max, char sha[65], struct coordinator_failure *failure);
bool recovery_hex(const char *value);
bool recovery_uuid(const char *value);
bool recovery_decimal(const char *value, uint64_t *number, bool positive);
uint64_t recovery_now(void);
bool recovery_fail(struct coordinator_failure *failure, const char *reason);
bool recovery_read_payload(size_t size, char **body, struct coordinator_failure *failure);
void recovery_reply(const struct json *j);

bool recovery_code(struct recovery *r, size_t image, pid_t pid, struct json *j, struct coordinator_failure *failure);
enum code_observation recovery_code_observe(struct recovery *r, size_t image, pid_t pid, struct json *j, struct coordinator_failure *failure);
void recovery_code_close(struct recovery *r);
enum process_observation recovery_process(struct recovery *r, pid_t pid, struct process_fact *out, enum census_mode mode, struct coordinator_failure *failure);
bool recovery_processes(struct recovery *r, struct process_fact *out, size_t *count, enum census_mode mode, struct coordinator_failure *failure);
void recovery_process_json(struct json *j, const struct process_fact *p);
bool recovery_peer(struct recovery *r, struct json *j, struct coordinator_failure *failure);
bool recovery_files_admission(struct recovery *r, struct json *j, struct coordinator_failure *failure);
bool recovery_metadata(struct recovery *r, const char *source, struct json *j, struct coordinator_failure *failure);
bool recovery_logs_arm(struct recovery *r, struct coordinator_failure *failure);
bool recovery_log_read(struct recovery *r, const char *source, struct json *j, struct coordinator_failure *failure);
bool recovery_logs_check(struct recovery *r, struct coordinator_failure *failure);
bool recovery_logs_finish(struct recovery *r, struct coordinator_failure *failure);
bool recovery_file_open(const char *path, struct file_fact *file, bool writable, struct coordinator_failure *failure);
bool recovery_file_check(const struct file_fact *file, struct coordinator_failure *failure);
void recovery_files_close(struct recovery *r);

bool recovery_bind_origin(struct recovery *r, char **args, struct json *j, struct coordinator_failure *failure);
bool recovery_bind_existing(struct recovery *r, char **args, struct json *j, struct coordinator_failure *failure);
bool recovery_bind_attempt(struct recovery *r, char **args, struct json *j, struct coordinator_failure *failure);
bool recovery_store_check(struct recovery *r, struct coordinator_failure *failure);
bool recovery_publish(struct recovery *r, const char *kind, const char *scope, const char *body, size_t length,
    struct json *j, char digest[65], struct coordinator_failure *failure);
bool recovery_read_receipt(struct recovery *r, const char *kind, const char *scope,
    struct json *j, struct coordinator_failure *failure);
bool recovery_archive(struct recovery *r, const char *which, struct json *j, struct coordinator_failure *failure);
bool recovery_reserve_attempt(struct recovery *r, struct coordinator_failure *failure);
bool recovery_sdk_decision(struct recovery *r, const char *kind, const char *scope, const char *body, size_t length,
    struct json *j, struct coordinator_failure *failure);

bool recovery_admission(struct recovery *r, struct json *j, struct coordinator_failure *failure);
bool recovery_arm(struct recovery *r, struct json *j, struct coordinator_failure *failure);
bool recovery_stopped(struct recovery *r, struct json *j, struct coordinator_failure *failure);
bool recovery_finish(struct recovery *r, struct json *j, struct coordinator_failure *failure);
bool recovery_abandon(struct recovery *r, const char *outcome, struct json *j, struct coordinator_failure *failure);
bool recovery_events(struct recovery *r, struct coordinator_failure *failure);
bool recovery_observing(const struct recovery *r);
bool recovery_observation_result(struct recovery *r, bool success, const struct coordinator_failure *failure);
bool recovery_wait_input(struct recovery *r, struct coordinator_failure *failure);
void recovery_close(struct recovery *r);

#endif
