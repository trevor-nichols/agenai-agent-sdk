#include "observer.h"

#include <CoreFoundation/CoreFoundation.h>
#include <SystemConfiguration/SystemConfiguration.h>
#include <arpa/inet.h>
#include <errno.h>
#include <net/if_dl.h>
#include <net/route.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <sys/utsname.h>
#include <unistd.h>

enum proxy_reason {
    PROXY_ENABLED = 1U, PAC_ENABLED = 2U, DISCOVERY_ENABLED = 4U,
    PROXY_UNKNOWN_KEY = 8U, PROXY_INVALID = 16U, PROXY_UNAVAILABLE = 32U,
    PROXY_BOUNDS = 64U
};
enum mask_origin { MASK_INTERFACE, MASK_ROUTE };

struct socket_record { const uint8_t *bytes; size_t length; };
static char output[HOST_OBSERVER_BYTES];
static size_t output_size;

static _Noreturn void fail(const char *code) {
    fprintf(stderr, "desktop_host_observer:%s\n", code);
    exit(1);
}

static void emit(const char *format, ...) __attribute__((format(printf, 1, 2)));

static void emit(const char *format, ...) {
    va_list args;
    va_start(args, format);
    int written = vsnprintf(output + output_size, sizeof(output) - output_size, format, args);
    va_end(args);
    if (written < 0 || (size_t)written >= sizeof(output) - output_size) fail("output_bound");
    output_size += (size_t)written;
}

static void emit_string(const char *text) {
    emit("\"");
    for (const unsigned char *next = (const unsigned char *)text; *next; next++) {
        if (*next < 32 || *next > 126) fail("non_ascii_identity");
        if (*next == '"' || *next == '\\') emit("\\%c", *next);
        else emit("%c", *next);
    }
    emit("\"");
}

static size_t aligned_length(size_t length) { return length ? (length + 3U) & ~(size_t)3U : 4U; }

static void sockets(const uint8_t *start, const uint8_t *end, uint32_t fields, struct socket_record records[RTAX_MAX]) {
    memset(records, 0, sizeof(struct socket_record) * RTAX_MAX);
    if (fields & ~((1U << RTAX_MAX) - 1U)) fail("unknown_sockaddr_field");
    for (size_t index = 0; index < RTAX_MAX; index++) {
        if (!(fields & (1U << index))) continue;
        if ((size_t)(end - start) < 2U) fail("short_sockaddr");
        size_t length = start[0];
        size_t aligned = aligned_length(length);
        if (length == 1U || aligned > (size_t)(end - start)) fail("truncated_sockaddr");
        records[index] = (struct socket_record){ start, length };
        start += aligned;
    }
    if (start != end) fail("sockaddr_trailing_bytes");
}

static void ip_diagnostic(struct socket_record record, const char *purpose, uint32_t interface_index) {
    char bytes[65] = {0};
    size_t captured = record.bytes ? aligned_length(record.length) : 0U;
    if (captured > 32U) captured = 32U;
    for (size_t index = 0; index < captured; index++) {
        int written = snprintf(bytes + index * 2U, sizeof(bytes) - index * 2U, "%02x", (unsigned)record.bytes[index]);
        if (written != 2) fail("ip_diagnostic_failed");
    }
    fprintf(stderr, "desktop_host_observer:ip_context {\"purpose\":\"%s\",\"interfaceIndex\":%u,"
        "\"sockaddrPresent\":%s,\"sockaddrLength\":%zu,\"sockaddrFamily\":%d,\"sockaddrHex\":\"%s\"}\n",
        purpose, interface_index, record.bytes ? "true" : "false", record.length,
        record.bytes ? (int)record.bytes[1] : -1, bytes);
}

static struct host_ip ip_address(struct socket_record record, const char *purpose, uint32_t interface_index) {
    struct host_ip result = {0};
    if (!record.bytes || record.length < 2U) { ip_diagnostic(record, purpose, interface_index); fail("missing_ip_address"); }
    if (record.bytes[1] == AF_INET) {
        if (record.length != sizeof(struct sockaddr_in)) fail("invalid_ipv4_sockaddr");
        struct sockaddr_in address;
        memcpy(&address, record.bytes, sizeof(address));
        result.family = 4;
        memcpy(result.bytes, &address.sin_addr, 4);
    } else if (record.bytes[1] == AF_INET6) {
        if (record.length != sizeof(struct sockaddr_in6)) fail("invalid_ipv6_sockaddr");
        struct sockaddr_in6 address;
        memcpy(&address, record.bytes, sizeof(address));
        result.family = 6;
        memcpy(result.bytes, &address.sin6_addr, 16);
        result.scope = address.sin6_scope_id;
        if (IN6_IS_ADDR_LINKLOCAL(&address.sin6_addr) || IN6_IS_ADDR_MC_NODELOCAL(&address.sin6_addr)
            || IN6_IS_ADDR_MC_LINKLOCAL(&address.sin6_addr)) {
            uint32_t embedded = ((uint32_t)result.bytes[2] << 8U) | result.bytes[3];
            if (embedded && result.scope && embedded != result.scope) fail("conflicting_ipv6_scope");
            if (embedded) result.scope = embedded;
            result.bytes[2] = result.bytes[3] = 0;
        } else if (result.scope) fail("unexpected_global_scope");
    } else { ip_diagnostic(record, purpose, interface_index); fail("unsupported_ip_family"); }
    result.present = true;
    return result;
}

static struct host_ip ip_mask(struct socket_record record, int family, bool host, enum mask_origin origin,
    uint32_t interface_index, uint32_t flags) {
    struct host_ip result = { .family = family, .present = true };
    size_t count = family == 4 ? 4U : 16U;
    size_t offset = family == 4 ? offsetof(struct sockaddr_in, sin_addr) : offsetof(struct sockaddr_in6, sin6_addr);
    const char *purpose = origin == MASK_ROUTE ? "route_netmask" : "interface_netmask";
    if (!record.bytes) {
        if (!host) fail("missing_netmask");
        memset(result.bytes, 255, count);
        return result;
    }
    if (!record.length) return result;
    bool radix_prefix = origin == MASK_ROUTE && record.length > offset && record.bytes[1] == UINT8_MAX;
    if (radix_prefix) {
        for (size_t index = 1U; index < offset; index++) {
            if (record.bytes[index] != UINT8_MAX) radix_prefix = false;
        }
    }
    if (record.length < 2U || (record.bytes[1] != AF_UNSPEC && record.bytes[1] != (family == 4 ? AF_INET : AF_INET6) && !radix_prefix)) {
        ip_diagnostic(record, purpose, interface_index);
        fprintf(stderr, "desktop_host_observer:mask_context {\"purpose\":\"%s\",\"interfaceIndex\":%u,"
            "\"expectedFamily\":%d,\"flags\":%u,\"hostRoute\":%s,\"addressOffset\":%zu}\n",
            purpose, interface_index, family, flags, host ? "true" : "false",
            family == 4 ? offsetof(struct sockaddr_in, sin_addr) : offsetof(struct sockaddr_in6, sin6_addr));
        fail("invalid_netmask_family");
    }
    size_t maximum = family == 4 ? sizeof(struct sockaddr_in) : sizeof(struct sockaddr_in6);
    if (record.length > maximum) fail("oversized_netmask");
    if (record.length > offset) {
        size_t copied = record.length - offset;
        if (copied > count) copied = count;
        memcpy(result.bytes, record.bytes + offset, copied);
    }
    bool zero_seen = false;
    for (size_t index = 0; index < count; index++) {
        for (int bit = 7; bit >= 0; bit--) {
            bool set = (result.bytes[index] & (1U << bit)) != 0;
            if (set && zero_seen) fail("noncontiguous_netmask");
            if (!set) zero_seen = true;
        }
    }
    return result;
}

static uint32_t link_index(struct socket_record record, char *name) {
    if (!record.bytes || record.length < offsetof(struct sockaddr_dl, sdl_data) || record.bytes[1] != AF_LINK) fail("invalid_link_sockaddr");
    struct sockaddr_dl link = {0};
    size_t copied = record.length < sizeof(link) ? record.length : sizeof(link);
    memcpy(&link, record.bytes, copied);
    if ((size_t)link.sdl_nlen + link.sdl_alen + link.sdl_slen > record.length - offsetof(struct sockaddr_dl, sdl_data)) fail("truncated_link_sockaddr");
    if (name) {
        if (!link.sdl_nlen || link.sdl_nlen >= IFNAMSIZ) fail("invalid_interface_name");
        memcpy(name, record.bytes + offsetof(struct sockaddr_dl, sdl_data), link.sdl_nlen);
        name[link.sdl_nlen] = '\0';
        for (size_t index = 0; index < link.sdl_nlen; index++) {
            unsigned char value = (unsigned char)name[index];
            if (!((value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z')
                || (value >= '0' && value <= '9') || value == '_' || value == '-' || value == '.')) fail("invalid_interface_name");
        }
    }
    return link.sdl_index;
}

static struct host_interface *find_interface(struct host_census *census, uint32_t index) {
    for (size_t cursor = 0; cursor < census->interface_count; cursor++) if (census->interfaces[cursor].index == index) return &census->interfaces[cursor];
    return NULL;
}

static struct host_interface *interface_for(struct host_census *census, uint32_t index) {
    struct host_interface *device = find_interface(census, index);
    if (device) return device;
    fail("unknown_interface_index");
}

static _Noreturn void unexpected_peer(const struct host_interface *device, const struct host_address *local,
    const struct host_ip *destination, struct socket_record record) {
    char local_text[INET6_ADDRSTRLEN], destination_text[INET6_ADDRSTRLEN];
    int address_family = local->address.family == 4 ? AF_INET : AF_INET6;
    if (!inet_ntop(address_family, local->address.bytes, local_text, sizeof(local_text))
        || !inet_ntop(address_family, destination->bytes, destination_text, sizeof(destination_text))) fail("peer_diagnostic_failed");
    fprintf(stderr, "desktop_host_observer:peer_context {\"interfaceIndex\":%u,\"interfaceName\":\"%s\","
        "\"interfaceFlags\":%u,\"addressFlags\":%u,\"family\":%d,\"local\":\"%s\",\"localScopeId\":%u,"
        "\"rtaxBrd\":{\"sockaddrLength\":%zu,\"sockaddrFamily\":%u,\"address\":\"%s\",\"scopeId\":%u}}\n",
        device->index, device->name, device->flags, local->flags, local->address.family, local_text, local->address.scope,
        record.length, (unsigned)record.bytes[1], destination_text, destination->scope);
    fail("unexpected_peer_address");
}

static void read_dump(int operation, int family, uint8_t **bytes, size_t *length) {
    int mib[] = { CTL_NET, PF_ROUTE, 0, family, operation, 0 };
    for (unsigned attempt = 0; attempt < 3; attempt++) {
        size_t needed = 0;
        if (sysctl(mib, 6, NULL, &needed, NULL, 0) != 0) fail("dump_size_failed");
        if (needed > HOST_OBSERVER_BYTES || (!needed && operation == NET_RT_IFLIST2)) fail("dump_size_bound");
        uint8_t *buffer = malloc(HOST_OBSERVER_BYTES);
        if (!buffer) fail("allocation_failed");
        needed = HOST_OBSERVER_BYTES;
        if (sysctl(mib, 6, buffer, &needed, NULL, 0) == 0) {
            if (needed > HOST_OBSERVER_BYTES || (!needed && operation == NET_RT_IFLIST2)) fail("invalid_dump_size");
            *bytes = buffer;
            *length = needed;
            return;
        }
        int error = errno;
        free(buffer);
        if (error != ENOMEM && error != ENOBUFS) fail("dump_read_failed");
    }
    fail("dump_changed_or_oversized");
}

static void read_interfaces(struct host_census *census) {
    uint8_t *bytes;
    size_t length;
    read_dump(NET_RT_IFLIST2, AF_UNSPEC, &bytes, &length);
    for (size_t cursor = 0; cursor < length;) {
        if (length - cursor < 4U) fail("short_interface_message");
        uint16_t size;
        memcpy(&size, bytes + cursor, sizeof(size));
        if (size < 4U || size > length - cursor || bytes[cursor + 2] != RTM_VERSION) fail("invalid_interface_message");
        const uint8_t *end = bytes + cursor + size;
        struct socket_record records[RTAX_MAX];
        switch (bytes[cursor + 3]) {
            case RTM_IFINFO2: {
                if (size < sizeof(struct if_msghdr2) || census->interface_count == HOST_OBSERVER_INTERFACES) fail("interface_bound");
                struct if_msghdr2 header;
                memcpy(&header, bytes + cursor, sizeof(header));
                sockets(bytes + cursor + sizeof(header), end, (uint32_t)header.ifm_addrs, records);
                struct host_interface *item = &census->interfaces[census->interface_count++];
                item->index = header.ifm_index;
                item->flags = (uint32_t)header.ifm_flags;
                if (!item->index || link_index(records[RTAX_IFP], item->name) != item->index) fail("interface_identity_mismatch");
                for (size_t index = 0; index + 1 < census->interface_count; index++) {
                    if (census->interfaces[index].index == item->index || !strcmp(census->interfaces[index].name, item->name)) fail("duplicate_interface");
                }
                break;
            }
            case RTM_NEWADDR: {
                if (size < sizeof(struct ifa_msghdr) || census->address_count == HOST_OBSERVER_ADDRESSES) fail("address_bound");
                struct ifa_msghdr header;
                memcpy(&header, bytes + cursor, sizeof(header));
                sockets(bytes + cursor + sizeof(header), end, (uint32_t)header.ifam_addrs, records);
                struct host_address *item = &census->addresses[census->address_count++];
                item->index = header.ifam_index;
                item->flags = (uint32_t)header.ifam_flags;
                struct host_interface *device = interface_for(census, item->index);
                item->address = ip_address(records[RTAX_IFA], "interface_address", item->index);
                item->mask = ip_mask(records[RTAX_NETMASK], item->address.family, false, MASK_INTERFACE, item->index, item->flags);
                if (records[RTAX_BRD].bytes) {
                    struct socket_record record = records[RTAX_BRD];
                    uint32_t placeholder = UINT32_MAX;
                    if (record.length == 0) memcpy(&placeholder, record.bytes, sizeof(placeholder));
                    bool empty_destination = item->address.family == 6 && (device->flags & (IFF_LOOPBACK | IFF_POINTOPOINT))
                        && record.length == 0 && placeholder == 0;
                    if (!empty_destination) {
                        struct host_ip destination = ip_address(record, "interface_destination", item->index);
                        if (destination.family != item->address.family) fail("peer_family_mismatch");
                        if (device->flags & IFF_LOOPBACK) {
                            size_t address_bytes = item->address.family == 4 ? 4U : 16U;
                            if (destination.scope != item->address.scope || memcmp(destination.bytes, item->address.bytes, address_bytes)) {
                                unexpected_peer(device, item, &destination, record);
                            }
                        } else if (device->flags & IFF_POINTOPOINT) item->peer = destination;
                        else if (device->flags & IFF_BROADCAST) item->broadcast = destination;
                        else unexpected_peer(device, item, &destination, record);
                    }
                }
                if (item->address.scope && item->address.scope != item->index) fail("address_scope_mismatch");
                break;
            }
            case RTM_NEWMADDR2: {
                if (size < sizeof(struct ifma_msghdr2)) fail("short_multicast_membership");
                struct ifma_msghdr2 header;
                memcpy(&header, bytes + cursor, sizeof(header));
                (void)interface_for(census, header.ifmam_index);
                sockets(bytes + cursor + sizeof(header), end, (uint32_t)header.ifmam_addrs, records);
                break;
            }
            default: fail("unknown_interface_message");
        }
        cursor += size;
    }
    free(bytes);
    if (!census->interface_count) fail("empty_interfaces");
}

static void route_scope_diagnostic(struct host_census *census, const struct host_route *route,
    struct socket_record record, const char *purpose, uint32_t scope) {
    char destination[INET6_ADDRSTRLEN], netmask[INET6_ADDRSTRLEN];
    int address_family = route->destination.family == 4 ? AF_INET : AF_INET6;
    if (!inet_ntop(address_family, route->destination.bytes, destination, sizeof(destination))
        || !inet_ntop(address_family, route->mask.bytes, netmask, sizeof(netmask))) fail("scope_diagnostic_failed");
    struct host_interface *device = interface_for(census, route->index);
    bool scope_observed = find_interface(census, scope) != NULL;
    ip_diagnostic(record, purpose, route->index);
    fprintf(stderr, "desktop_host_observer:scope_context {\"purpose\":\"%s\",\"family\":%d,"
        "\"destination\":\"%s\",\"netmask\":\"%s\",\"scopeId\":%u,\"scopeInterfaceObserved\":%s,"
        "\"routeInterfaceIndex\":%u,\"routeInterfaceName\":\"%s\",\"routeInterfaceFlags\":%u,"
        "\"routeFlags\":%u,\"parentFlags\":%u}\n", purpose, route->destination.family,
        destination, netmask, scope, scope_observed ? "true" : "false", route->index, device->name,
        device->flags, route->flags, route->parent_flags);
}

static void read_routes(struct host_census *census, int family) {
    uint8_t *bytes;
    size_t length;
    read_dump(NET_RT_DUMP2, family, &bytes, &length);
    for (size_t cursor = 0; cursor < length;) {
        if (length - cursor < sizeof(struct rt_msghdr2)) fail("short_route_message");
        struct rt_msghdr2 header;
        memcpy(&header, bytes + cursor, sizeof(header));
        if (header.rtm_msglen < sizeof(header) || header.rtm_msglen > length - cursor
            || header.rtm_version != RTM_VERSION || header.rtm_type != RTM_GET2 || header.rtm_reserved) {
            fprintf(stderr, "desktop_host_observer:route_context {\"dumpOperation\":%d,\"requestedFamily\":%d,"
                "\"offset\":%zu,\"remainingBytes\":%zu,\"headerBytes\":%zu,\"messageLength\":%u,"
                "\"version\":%u,\"type\":%u,\"interfaceIndex\":%u,\"flags\":%u,\"parentFlags\":%u,"
                "\"addressFields\":%u,\"reserved\":%d,\"expectedVersion\":%u,\"rtmGet\":%u,\"rtmGet2\":%u}\n",
                NET_RT_DUMP2, family, cursor, length - cursor, sizeof(header), (unsigned)header.rtm_msglen,
                (unsigned)header.rtm_version, (unsigned)header.rtm_type, (unsigned)header.rtm_index,
                (unsigned)header.rtm_flags, (unsigned)header.rtm_parentflags, (unsigned)header.rtm_addrs,
                header.rtm_reserved, (unsigned)RTM_VERSION, (unsigned)RTM_GET, (unsigned)RTM_GET2);
            fail("invalid_route_message");
        }
        if (census->route_count == HOST_OBSERVER_ROUTES) fail("route_bound");
        struct socket_record records[RTAX_MAX];
        sockets(bytes + cursor + sizeof(header), bytes + cursor + header.rtm_msglen, (uint32_t)header.rtm_addrs, records);
        struct host_route *item = &census->routes[census->route_count++];
        item->index = header.rtm_index;
        item->flags = (uint32_t)header.rtm_flags;
        item->parent_flags = (uint32_t)header.rtm_parentflags;
        if ((item->flags | item->parent_flags) & ~UINT32_C(0x7ff7ffff)) fail("unknown_route_flag");
        (void)interface_for(census, item->index);
        item->destination = ip_address(records[RTAX_DST], "route_destination", item->index);
        if ((item->destination.family == 4 ? AF_INET : AF_INET6) != family) fail("route_family_mismatch");
        item->mask = ip_mask(records[RTAX_NETMASK], item->destination.family, (item->flags & RTF_HOST) != 0,
            MASK_ROUTE, item->index, item->flags);
        if (item->destination.scope && !find_interface(census, item->destination.scope)) {
            route_scope_diagnostic(census, item, records[RTAX_DST], "route_destination_scope", item->destination.scope);
            fail("route_scope_unobserved");
        }
        if (records[RTAX_GATEWAY].bytes) {
            if (records[RTAX_GATEWAY].length >= 2U && records[RTAX_GATEWAY].bytes[1] == AF_LINK) {
                item->link_gateway = link_index(records[RTAX_GATEWAY], NULL);
                bool gateway_observed = find_interface(census, item->link_gateway) != NULL;
                if (!gateway_observed) {
                    char destination[INET6_ADDRSTRLEN], netmask[INET6_ADDRSTRLEN];
                    int address_family = item->destination.family == 4 ? AF_INET : AF_INET6;
                    if (!inet_ntop(address_family, item->destination.bytes, destination, sizeof(destination))
                        || !inet_ntop(address_family, item->mask.bytes, netmask, sizeof(netmask))) fail("gateway_diagnostic_failed");
                    struct host_interface *device = interface_for(census, item->index);
                    ip_diagnostic(records[RTAX_GATEWAY], "route_link_gateway", item->index);
                    fprintf(stderr, "desktop_host_observer:gateway_context {\"family\":%d,\"destination\":\"%s\","
                        "\"netmask\":\"%s\",\"scopeId\":%u,\"routeFlags\":%u,\"parentFlags\":%u,"
                        "\"routeInterfaceIndex\":%u,\"routeInterfaceName\":\"%s\",\"routeInterfaceFlags\":%u,"
                        "\"linkGatewayInterfaceIndex\":%u}\n", item->destination.family, destination, netmask,
                        item->destination.scope, item->flags, item->parent_flags, item->index, device->name,
                        device->flags, item->link_gateway);
                    fail("gateway_interface_unobserved");
                }
            } else {
                item->gateway = ip_address(records[RTAX_GATEWAY], "route_gateway", item->index);
                if (item->gateway.family != item->destination.family
                    || (item->gateway.scope && !find_interface(census, item->gateway.scope))) {
                    route_scope_diagnostic(census, item, records[RTAX_GATEWAY], "route_gateway_scope", item->gateway.scope);
                    fail("gateway_scope_mismatch");
                }
            }
        } else if (item->flags & RTF_GATEWAY) fail("missing_route_gateway");
        cursor += header.rtm_msglen;
    }
    free(bytes);
}

static bool key_is(CFStringRef key, const char *expected) {
    CFStringRef text = CFStringCreateWithCString(NULL, expected, kCFStringEncodingASCII);
    if (!text) fail("allocation_failed");
    bool equal = CFEqual(key, text);
    CFRelease(text);
    return equal;
}

static void proxy_reason(struct host_proxy *proxy, uint32_t reason, bool unsafe) {
    proxy->reasons |= reason;
    if (unsafe) proxy->unsafe = true;
    else proxy->unknown = true;
}

static bool proxy_budget(struct host_proxy *proxy, CFTypeRef value, unsigned depth) {
    if (++proxy->entries > 4096U || depth > 8U) { proxy_reason(proxy, PROXY_BOUNDS, false); return false; }
    if (CFGetTypeID(value) == CFStringGetTypeID()) {
        CFIndex count = CFStringGetLength((CFStringRef)value);
        if (count < 0 || count > 65536) { proxy_reason(proxy, PROXY_BOUNDS, false); return false; }
        proxy->string_bytes += (size_t)count * 4U;
        if (proxy->string_bytes > 1024U * 1024U) { proxy_reason(proxy, PROXY_BOUNDS, false); return false; }
    }
    return true;
}

static void proxy_dictionary(struct host_proxy *, CFDictionaryRef, unsigned);

static void proxy_collection(struct host_proxy *proxy, CFTypeRef value, unsigned depth) {
    if (!proxy_budget(proxy, value, depth)) return;
    if (CFGetTypeID(value) == CFArrayGetTypeID()) {
        CFArrayRef list = value;
        CFIndex count = CFArrayGetCount(list);
        if (count > 256) { proxy_reason(proxy, PROXY_BOUNDS, false); return; }
        for (CFIndex index = 0; index < count; index++) {
            CFTypeRef child = CFArrayGetValueAtIndex(list, index);
            if (CFGetTypeID(child) != CFDictionaryGetTypeID()) proxy_reason(proxy, PROXY_INVALID, false);
            else proxy_dictionary(proxy, child, depth + 1U);
        }
    } else if (CFGetTypeID(value) == CFDictionaryGetTypeID()) {
        CFIndex count = CFDictionaryGetCount(value);
        if (count > 256) { proxy_reason(proxy, PROXY_BOUNDS, false); return; }
        const void *keys[256], *values[256];
        CFDictionaryGetKeysAndValues(value, keys, values);
        for (CFIndex index = 0; index < count; index++) {
            if (CFGetTypeID(keys[index]) != CFStringGetTypeID() || !proxy_budget(proxy, keys[index], depth + 1U)
                || CFGetTypeID(values[index]) != CFDictionaryGetTypeID()) proxy_reason(proxy, PROXY_INVALID, false);
            else proxy_dictionary(proxy, values[index], depth + 1U);
        }
    } else proxy_reason(proxy, PROXY_INVALID, false);
}

static void proxy_dictionary(struct host_proxy *proxy, CFDictionaryRef dictionary, unsigned depth) {
    if (!proxy_budget(proxy, dictionary, depth)) return;
    if (++proxy->scopes > 256U) { proxy_reason(proxy, PROXY_BOUNDS, false); return; }
    CFIndex count = CFDictionaryGetCount(dictionary);
    if (count > 256) { proxy_reason(proxy, PROXY_BOUNDS, false); return; }
    const void *keys[256], *values[256];
    CFDictionaryGetKeysAndValues(dictionary, keys, values);
    for (CFIndex index = 0; index < count; index++) {
        CFTypeRef key = keys[index], value = values[index];
        if (CFGetTypeID(key) != CFStringGetTypeID() || !proxy_budget(proxy, key, depth + 1U)
            || !proxy_budget(proxy, value, depth + 1U)) { proxy_reason(proxy, PROXY_INVALID, false); continue; }
        char text[128];
        if (!CFStringGetCString(key, text, sizeof(text), kCFStringEncodingASCII)) { proxy_reason(proxy, PROXY_UNKNOWN_KEY, false); continue; }
        if (!strcmp(text, "__SCOPED__") || !strcmp(text, "__SERVICES__") || !strcmp(text, "__SUPPLEMENTAL__")) {
            proxy_collection(proxy, value, depth + 1U);
            continue;
        }
        bool enable = key_is(key, "HTTPEnable") || key_is(key, "HTTPSEnable") || key_is(key, "SOCKSEnable")
            || key_is(key, "FTPEnable") || key_is(key, "GopherEnable") || key_is(key, "RTSPEnable")
            || key_is(key, "ProxyAutoConfigEnable") || key_is(key, "ProxyAutoDiscoveryEnable");
        bool boolean = enable || key_is(key, "FTPPassive") || key_is(key, "ExcludeSimpleHostnames")
            || key_is(key, "BypassAllowed") || key_is(key, "FallBackAllowed");
        if (boolean) {
            int number = -1;
            if (CFGetTypeID(value) != CFNumberGetTypeID() || !CFNumberGetValue(value, kCFNumberIntType, &number)
                || (number != 0 && number != 1)) proxy_reason(proxy, PROXY_INVALID, false);
            else if (enable && number) proxy_reason(proxy, key_is(key, "ProxyAutoConfigEnable") ? PAC_ENABLED
                : key_is(key, "ProxyAutoDiscoveryEnable") ? DISCOVERY_ENABLED : PROXY_ENABLED, true);
            continue;
        }
        const char *strings[] = {"FTPProxy", "FTPUser", "GopherProxy", "GopherUser", "HTTPProxy", "HTTPUser", "HTTPSProxy", "HTTPSUser",
            "RTSPProxy", "RTSPUser", "SOCKSProxy", "SOCKSUser", "ProxyAutoConfigJavaScript", "ProxyAutoConfigURLString", "__MATCH_DOMAIN__"};
        bool recognized = false;
        for (size_t cursor = 0; cursor < sizeof(strings) / sizeof(strings[0]); cursor++) {
            if (!strcmp(text, strings[cursor])) {
                recognized = true;
                if (CFGetTypeID(value) != CFStringGetTypeID()) proxy_reason(proxy, PROXY_INVALID, false);
                break;
            }
        }
        if (recognized) continue;
        const char *numbers[] = {"FTPPort", "GopherPort", "HTTPPort", "HTTPSPort", "RTSPPort", "SOCKSPort", "__MATCH_ORDER__"};
        for (size_t cursor = 0; cursor < sizeof(numbers) / sizeof(numbers[0]); cursor++) {
            if (!strcmp(text, numbers[cursor])) {
                recognized = true;
                int64_t number;
                if (CFGetTypeID(value) != CFNumberGetTypeID() || !CFNumberGetValue(value, kCFNumberSInt64Type, &number)
                    || number < 0 || number > UINT32_MAX) proxy_reason(proxy, PROXY_INVALID, false);
                break;
            }
        }
        if (recognized) continue;
        if (!strcmp(text, "ExceptionsList") || !strcmp(text, "SupplementalMatchDomains") || !strcmp(text, "SupplementalMatchOrders")) {
            if (CFGetTypeID(value) != CFArrayGetTypeID() || CFArrayGetCount(value) > 256) { proxy_reason(proxy, PROXY_INVALID, false); continue; }
            for (CFIndex cursor = 0; cursor < CFArrayGetCount(value); cursor++) {
                CFTypeRef child = CFArrayGetValueAtIndex(value, cursor);
                if (!proxy_budget(proxy, child, depth + 2U) || CFGetTypeID(child) != (!strcmp(text, "SupplementalMatchOrders") ? CFNumberGetTypeID() : CFStringGetTypeID())) proxy_reason(proxy, PROXY_INVALID, false);
            }
            continue;
        }
        proxy_reason(proxy, PROXY_UNKNOWN_KEY, false);
    }
}

static struct host_proxy read_proxy(void) {
    struct host_proxy proxy = {0};
    SCDynamicStoreRef store = SCDynamicStoreCreate(NULL, CFSTR("agenai.desktop-host-observer"), NULL, NULL);
    if (!store) { proxy_reason(&proxy, PROXY_UNAVAILABLE, false); return proxy; }
    CFDictionaryRef configuration = SCDynamicStoreCopyProxies(store);
    if (!configuration) proxy_reason(&proxy, PROXY_UNAVAILABLE, false);
    else {
        proxy_dictionary(&proxy, configuration, 0);
        CFRelease(configuration);
    }
    CFRelease(store);
    return proxy;
}

static void emit_ip(const struct host_ip *address) {
    char text[INET6_ADDRSTRLEN];
    if (!address->present || !inet_ntop(address->family == 4 ? AF_INET : AF_INET6, address->bytes, text, sizeof(text))) fail("address_format_failed");
    emit_string(text);
}

static void emit_peer(const struct host_ip *address) {
    if (!address->present) emit("null");
    else { emit("{\"address\":"); emit_ip(address); emit(",\"scopeId\":%u}", address->scope); }
}

int main(int argc, char **argv) {
    (void)argv;
    if (argc != 1) fail("arguments_unsupported");
#if !defined(__APPLE__) || !defined(__aarch64__)
    fail("requires_darwin_arm64");
#endif
    struct host_census *census = calloc(1, sizeof(*census));
    if (!census) fail("allocation_failed");
    read_interfaces(census);
    read_routes(census, AF_INET);
    read_routes(census, AF_INET6);
    struct host_proxy proxy = read_proxy();
    struct utsname identity;
    if (uname(&identity) != 0 || strcmp(identity.sysname, "Darwin") || strcmp(identity.machine, "arm64")) fail("host_identity_failed");
    char build[128] = {0};
    size_t build_size = sizeof(build);
    if (sysctlbyname("kern.osversion", build, &build_size, NULL, 0) != 0 || !build_size || build_size > sizeof(build) || build[build_size - 1]) fail("os_build_failed");
    struct timeval boot;
    size_t boot_size = sizeof(boot);
    if (sysctlbyname("kern.boottime", &boot, &boot_size, NULL, 0) != 0 || boot_size != sizeof(boot)
        || boot.tv_sec < 0 || boot.tv_usec < 0 || boot.tv_usec > 999999) fail("boot_identity_failed");
    emit("{\"format\":\"agenai.desktop-host-network.v1\",\"complete\":true,\"host\":{\"kernel\":");
    emit_string(identity.release);
    emit(",\"architecture\":\"arm64\",\"osBuild\":"); emit_string(build);
    emit(",\"boot\":{\"seconds\":%lld,\"microseconds\":%d}},\"interfaces\":[", (long long)boot.tv_sec, boot.tv_usec);
    for (size_t index = 0; index < census->interface_count; index++) {
        struct host_interface *device = &census->interfaces[index];
        if (index) emit(",");
        emit("{\"index\":%u,\"name\":", device->index); emit_string(device->name);
        emit(",\"flags\":%u,\"addresses\":[", device->flags);
        bool first = true;
        for (size_t cursor = 0; cursor < census->address_count; cursor++) {
            struct host_address *address = &census->addresses[cursor];
            if (address->index != device->index) continue;
            if (!first) emit(",");
            first = false;
            emit("{\"family\":%d,\"address\":", address->address.family); emit_ip(&address->address);
            emit(",\"netmask\":"); emit_ip(&address->mask);
            emit(",\"scopeId\":%u,\"flags\":%u,\"peer\":", address->address.scope, address->flags); emit_peer(&address->peer);
            emit(",\"broadcast\":"); emit_peer(&address->broadcast); emit("}");
        }
        emit("]}");
    }
    emit("],\"routes\":[");
    for (size_t index = 0; index < census->route_count; index++) {
        struct host_route *route = &census->routes[index];
        if (index) emit(",");
        emit("{\"family\":%d,\"destination\":", route->destination.family); emit_ip(&route->destination);
        emit(",\"netmask\":"); emit_ip(&route->mask);
        emit(",\"scopeId\":%u,\"interfaceIndex\":%u,\"flags\":%u,\"parentFlags\":%u,\"gateway\":",
            route->destination.scope, route->index, route->flags, route->parent_flags);
        if (route->gateway.present) {
            emit("{\"kind\":\"ip\",\"family\":%d,\"address\":", route->gateway.family); emit_ip(&route->gateway);
            emit(",\"scopeId\":%u}", route->gateway.scope);
        } else if (route->link_gateway) emit("{\"kind\":\"link\",\"interfaceIndex\":%u}", route->link_gateway);
        else emit("null");
        emit("}");
    }
    emit("],\"proxy\":{\"status\":\"%s\",\"reasonCodes\":[", proxy.unknown ? "unknown" : proxy.unsafe ? "unsafe" : "safe");
    const char *reasons[] = {"enabled_proxy", "enabled_pac", "enabled_discovery", "unknown_key", "invalid_value", "unavailable", "bounds"};
    bool first = true;
    for (size_t index = 0; index < sizeof(reasons) / sizeof(reasons[0]); index++) if (proxy.reasons & (1U << index)) {
        if (!first) emit(",");
        first = false;
        emit_string(reasons[index]);
    }
    emit("],\"scopes\":%zu,\"entries\":%zu}}\n", proxy.scopes, proxy.entries);
    free(census);
    size_t written = 0;
    while (written < output_size) {
        ssize_t count = write(STDOUT_FILENO, output + written, output_size - written);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) fail("output_write_failed");
        written += (size_t)count;
    }
    return 0;
}
