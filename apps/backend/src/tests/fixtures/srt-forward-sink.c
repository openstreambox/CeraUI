/* Native loopback sink: require the exact SRT identity before accepting bytes. */
#include <srt/srt.h>
#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    srt_startup();
    SRTSOCKET listener = srt_create_socket();
    struct sockaddr_in addr = { .sin_family = AF_INET,
        .sin_port = htons(atoi(argv[1])), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    if (srt_bind(listener, (struct sockaddr *)&addr, sizeof(addr)) ||
        srt_listen(listener, 1)) return 3;
    SRTSOCKET peer = srt_accept(listener, NULL, NULL);
    if (peer == SRT_INVALID_SOCK) return 4;
    char identity[1024] = {0};
    int size = sizeof(identity);
    if (srt_getsockflag(peer, SRTO_STREAMID, identity, &size) ||
        strcmp(identity, argv[2])) return 5;
    char payload[1316];
    int count;
    while ((count = srt_recvmsg(peer, payload, sizeof(payload))) > 0) {
        int offset = 0;
        while (offset < count) {
            ssize_t written = write(STDOUT_FILENO, payload + offset, count - offset);
            if (written <= 0) return 6;
            offset += written;
        }
    }
    srt_close(peer);
    srt_close(listener);
    srt_cleanup();
    return 0;
}
