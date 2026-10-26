# The instances' computers (ADR 0013): docker build -f docker/computer.Dockerfile -t owni-computer:latest docker
# Owni runs it with a network out to the public internet only (ADR 0124) and no secrets,
# read-only except /work and /tmp: commands as uid 1000; the container's first process, as root
# with only NET_ADMIN, closes the way to private addresses (owni-run guard) and idles. The tools
# here are what a computer starts with; with the system read-only, a command installs more in
# /work or /tmp (pip install, a clone, a download). A custom image keeps uid 1000, /work owned by
# it, sh, timeout, du, chmod, python3, iptables and /usr/local/bin/owni-run.
#
# On micro-VMs (ADR 0015) the same tools run from the `fly` target:
#   docker build -f docker/computer.Dockerfile --target fly -t <registry>/owni-computer:fly docker
FROM debian:bookworm-slim AS tools

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates coreutils file bc jq sqlite3 zip unzip xz-utils curl git python3-pip iptables \
      python3 python3-pandas python3-openpyxl python3-xlrd python3-matplotlib python3-pypdf weasyprint \
      pandoc poppler-utils qpdf imagemagick ghostscript fonts-dejavu-core procps \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 owni && useradd -u 1000 -g 1000 -d /tmp -s /bin/sh owni \
 && mkdir /work && chown 1000:1000 /work \
 && printf '[global]\nuser = true\nbreak-system-packages = true\n' > /etc/pip.conf \
 # Nothing for uid 1000 to gain privileges from: no setuid or setgid programs.
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} +
# pip install goes to /work/.local: packages stay with the files, and count against the quota.
ENV HOME=/tmp LANG=C.UTF-8 MPLBACKEND=Agg PYTHONUSERBASE=/work/.local PATH=/work/.local/bin:/usr/local/bin:/usr/bin:/bin
# The egress rules and the runner, the same on both targets (ADR 0124).
COPY --chmod=755 owni-run.py /usr/local/bin/owni-run

# A micro-VM: its first process runs as root to close Fly's API and private addresses, then
# idles; commands arrive through Fly's exec API and run as uid 1000 through owni-run.
FROM tools AS fly
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-seccomp \
 && rm -rf /var/lib/apt/lists/* \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} +
COPY --chmod=755 owni-fly-init /usr/local/bin/owni-fly-init
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/owni-fly-init"]

# The default target: a container per instance on a Docker host (ADR 0013). Owni starts it as
# root with only NET_ADMIN running `owni-run guard`; this default is for running it by hand.
FROM tools
USER 1000:1000
WORKDIR /work
CMD ["sleep", "infinity"]
