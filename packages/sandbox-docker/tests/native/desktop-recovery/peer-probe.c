#include "recovery.h"
#include <stdio.h>
#include <string.h>

/* Read-only probe of the production peer observer; never a recovery/barrier issuer. */
int main(int argc, char **argv) {
    struct recovery observer = {0};
    if (argc != 2 || strlen(argv[1]) >= sizeof(observer.endpoint)) return 64;
    strcpy(observer.endpoint, argv[1]);
    struct json peer; json_init(&peer);
    struct coordinator_failure failure = {0};
    bool ok = recovery_peer(&observer, &peer, &failure);
    if (ok) {
        printf("{\"kind\":\"peer_probe\",\"peer\":%s}\n", peer.data);
    } else {
        printf("{\"kind\":\"probe_refusal\",\"reason\":\"%s\",\"errno\":%d}\n", failure.reason, failure.error);
    }
    json_free(&peer); return ok ? 0 : 1;
}
