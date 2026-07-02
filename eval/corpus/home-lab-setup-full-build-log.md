---
title: "Home lab setup — full build log"
lang: en
tags: [code]
---

# Home lab — full build log

The running log of the home server, start to finish, so future-me can rebuild it
from scratch after the inevitable day I break something unrecoverable. Long by
design. Everything self-hosted, nothing in someone else's cloud unless it has to
be.

## Goals

What I actually wanted before I bought a single thing, because otherwise this
hobby eats money forever:

- One always-on machine for services (media, files, git, dashboards).
- Network-wide ad and tracker filtering so every device benefits, not just the
  browsers with extensions.
- My own file sync so I stop paying a subscription to hold my own photos hostage.
- Backups that are automatic, off-site, and tested — a backup you've never
  restored is a rumour, not a backup.
- Quiet and low-power. It lives in a cupboard in the hall, not a datacentre.

## Hardware

The parts list, roughly in order of how much I agonised over each one:

- **Mini PC** — the main workhorse. Small x86 box, 32 GB RAM, a 1 TB NVMe boot
  drive. Runs everything in Docker. Idles low, which matters when it never turns
  off.
- **NAS** — a 4-bay unit populated with 4×4 TB drives in **RAID5**, so one drive
  can die without taking the data with it. Gives about 12 TB usable. This holds
  the media library and the Nextcloud data.
- **Raspberry Pi 5** — dedicated to DNS. It does one job so a reboot of the main
  box never takes the whole house's internet down with it.
- A cheap 8-port gigabit switch and a small UPS so a brief power blip doesn't
  corrupt a write mid-flight.

Lesson already learned: buy the drives from two different batches. Drives from the
same batch tend to fail around the same time, which rather defeats the point of
the array.

## Networking

Everything lives on the `192.168.1.0/24` LAN.

- The main box has a **static IP of 192.168.1.10** so the reverse proxy and the
  bookmarks never chase a moving DHCP lease.
- The Pi is at `192.168.1.53` (chosen so I'd remember it — port 53 is DNS).
- In the router's DHCP settings I set the Pi as the **primary DNS server** for the
  whole network, so every phone, laptop and smart-whatever resolves through it.

### Pi-hole

The Pi runs **Pi-hole**, which sinkholes ad and tracker domains at the DNS layer —
it answers "does not exist" for anything on its blocklists, so the ads never even
get fetched. The whole house benefits, including the devices you can't install an
extension on (the TV, the phones, the visiting relatives).

```sh
curl -sSL https://install.pi-hole.net | bash
# then set upstream resolvers to a privacy-respecting provider,
# and point the router's DHCP DNS at 192.168.1.53
```

One gotcha: if the Pi ever goes down, DNS goes down, and to a normal human "the
internet is broken." I set a secondary DNS on the router as a fallback so a dead
Pi degrades to "ads are back" instead of "nothing loads."

## OS and base setup

The mini PC runs a stock **Debian stable** — boring on purpose, I want security
updates for years, not a distro I have to babysit. First-boot checklist:

```sh
# non-root user, keys only, no password SSH
adduser lab && usermod -aG sudo lab
# harden sshd: PasswordAuthentication no, PermitRootLogin no
sudo systemctl restart ssh
# unattended-upgrades so security patches land without me
sudo apt install unattended-upgrades && sudo dpkg-reconfigure unattended-upgrades
```

Then Docker and the compose plugin, because every service below is a container.
Nothing gets installed on the host directly if a container can do it — keeps the
base OS clean and every service disposable.

## The Docker stack

One `docker-compose.yml` to rule them all, in `/opt/stack`, everything defined as
code so the whole thing is reproducible and the config lives in git.

```yaml
services:
  jellyfin:
    image: jellyfin/jellyfin
    volumes:
      - ./config/jellyfin:/config
      - /mnt/nas/media:/media:ro
    restart: unless-stopped

  nextcloud:
    image: nextcloud
    volumes:
      - /mnt/nas/nextcloud:/var/www/html/data
    restart: unless-stopped

  gitea:
    image: gitea/gitea
    volumes:
      - ./config/gitea:/data
    restart: unless-stopped

  uptime-kuma:
    image: louislam/uptime-kuma
    volumes:
      - ./config/uptime:/app/data
    restart: unless-stopped
```

What each one earns its keep doing:

- **Jellyfin** — the media server. Reads the library off the NAS read-only, so a
  bug in Jellyfin can never delete my films. It transcodes on the fly for the
  devices that need it.
- **Nextcloud** — file sync and photo backup. This is the one that replaced a
  paid subscription. Phone auto-uploads photos to it over the LAN, and off-site
  when I'm away.
- **Gitea** — a tiny self-hosted git server for my own repos and these very notes.
  Lightweight, does exactly what a private GitHub-lite should.
- **Uptime Kuma** — pings the other services and shouts at me if one falls over.
  The watcher that watches the watchmen.

## Reverse proxy

Rather than remember a dozen port numbers, everything sits behind **Caddy** on
**port 443**, with a nice hostname per service (`jellyfin.lab.home`,
`cloud.lab.home`, and so on, resolved locally by the Pi).

```
jellyfin.lab.home {
    reverse_proxy jellyfin:8096
}

cloud.lab.home {
    reverse_proxy nextcloud:80
}
```

Caddy handles TLS automatically, so it's HTTPS everywhere on the LAN with real
certificates, no browser warnings, no clicking through "your connection is not
private" every single time. This is the single quality-of-life upgrade I wish I'd
done first instead of last.

## Backups

The part everyone skips and everyone regrets skipping. The rule I hold myself to
is **3-2-1**: three copies of the data, on two kinds of media, one of them
off-site.

- Copy one: the live data on the NAS (RAID5 protects against a *drive* dying, not
  against me `rm -rf`-ing the wrong directory — RAID is not a backup).
- Copy two: a nightly local snapshot to a separate USB drive.
- Copy three: **nightly `restic` to Backblaze B2**, encrypted client-side so the
  cloud provider only ever sees ciphertext.

```sh
# nightly, via cron/systemd timer
export RESTIC_REPOSITORY="b2:my-lab-backup"
restic backup /mnt/nas/nextcloud /opt/stack/config
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
```

Crucially I actually **test the restore** — first Sunday of the month I restore a
random file from B2 to a scratch directory and diff it against the original. The
one time I skipped that for a few months I found the backup had been silently
failing on a permissions error. Never again.

## Monitoring

**Prometheus** scrapes metrics, **Grafana** draws the pretty graphs. Node-exporter
on the host feeds CPU, RAM, disk and temperature; I care most about the disk
graphs — a drive that's filling up or running hot is the early warning that saves
a weekend.

The one alert that has genuinely earned its place: **disk usage over 85%**. It has
caught the media library quietly eating the array twice before it became an
emergency. Everything else is nice-to-have; that one is load-bearing.

## Troubleshooting log

Real problems, in the order they bit me:

- **Containers couldn't reach the NAS after a reboot.** The NAS mount hadn't come
  up before Docker started. Fixed with a systemd dependency so the mount is
  required before the stack starts.
- **Jellyfin transcoding pegged the CPU** and made everything else crawl. Capped
  its CPU quota in compose and enabled hardware transcoding — problem gone.
- **Certificates weren't renewing** on the internal names for a while because
  Caddy couldn't reach the ACME challenge; switched the internal domains to
  Caddy's internal CA and stopped fighting it.
- **The Pi's SD card corrupted** after a hard power loss. Moved its boot to a
  small SSD over USB and added it to the UPS. SD cards are for cameras, not for
  things that must survive a reboot.

## Lessons

If I did it all again from an empty cupboard:

1. Reverse proxy and real internal certificates on day one, not month six.
2. Backups configured and *restore-tested* before I put a single irreplaceable
   file on the thing.
3. Everything as code — one compose file, in git — so a total rebuild is an
   afternoon, not a fortnight of half-remembered `apt install` commands.
4. Keep DNS on its own tiny box. Decoupling the thing the whole house depends on
   from the thing I'm always tinkering with was the best decision here.

Still to do: a second off-site copy at my brother's place over a VPN, and figure
out whether I actually need Kubernetes for any of this (I do not, but the itch is
real).
