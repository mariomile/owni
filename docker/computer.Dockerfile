# The instances' computers (ADR 0013): docker build -f docker/computer.Dockerfile -t owni-computer:latest docker
# Owni runs it with no network, read-only except /work and /tmp: commands as uid 1000, the
# container itself idles as nobody. The tools here are all a computer has: it cannot install
# anything at run time. A custom image keeps uid 1000, /work owned by it, sh, timeout, du and chmod.
#
# On micro-VMs (ADR 0015) the same tools run from the `fly` target:
#   docker build -f docker/computer.Dockerfile --target fly -t <registry>/owni-computer:fly docker
FROM debian:bookworm-slim AS tools

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates coreutils file bc jq sqlite3 zip unzip xz-utils \
      python3 python3-pandas python3-openpyxl python3-xlrd python3-matplotlib python3-pypdf weasyprint \
      pandoc poppler-utils qpdf imagemagick ghostscript fonts-dejavu-core procps \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 owni && useradd -u 1000 -g 1000 -d /tmp -s /bin/sh owni \
 && mkdir /work && chown 1000:1000 /work
ENV HOME=/tmp LANG=C.UTF-8 MPLBACKEND=Agg

# A micro-VM: its first process runs as root to seal it off the network, then idles; commands
# arrive through Fly's exec API and run as uid 1000 through owni-run.
FROM tools AS fly
RUN apt-get update \
 && apt-get install -y --no-install-recommends iptables python3-seccomp \
 && rm -rf /var/lib/apt/lists/* \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} +
COPY --chmod=755 owni-run.py /usr/local/bin/owni-run
COPY --chmod=755 owni-fly-init /usr/local/bin/owni-fly-init
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/owni-fly-init"]

# The default target: a container per instance on a Docker host (ADR 0013).
FROM tools
USER 1000:1000
WORKDIR /work
CMD ["sleep", "infinity"]
