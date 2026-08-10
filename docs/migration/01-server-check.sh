#!/usr/bin/env bash
# =============================================================================
#  Data365 — 1-BOSQICH: SERVER TEKSHIRUVI  (read-only)
# =============================================================================
#  Bu skript serverda HECH NARSANI o'zgartirmaydi.
#  Hech narsa o'rnatmaydi, o'chirmaydi, to'xtatmaydi, qayta ishga tushirmaydi.
#  U faqat O'QIYDI va oxirida bitta hisobot chiqaradi.
#
#  Ishga tushirish:
#      bash 01-server-check.sh
#
#  Natijani (ekrandagi hammasini) nusxalab bizga yuboring.
# =============================================================================
#
#  DIQQAT (o'qiydigan odam uchun): bu faylni ishga tushirishdan oldin uni
#  o'zingiz o'qib chiqishingiz mumkin va shunday qilishingizni tavsiya qilamiz.
#  Ichida faqat ma'lumot yig'adigan buyruqlar bor: docker ps, free, df, ss va h.k.
#  Hech qaerga hech narsa yuborilmaydi — chiqish faqat sizning ekraningizga.
# =============================================================================

set -uo pipefail   # `-e` YO'Q: bitta tekshiruv muvaffaqiyatsiz bo'lsa ham davom etsin

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; RESET=$'\033[0m'

# Terminal rangni qo'llab-quvvatlamasa, bo'yoqni o'chiramiz
if [ ! -t 1 ]; then BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""; fi

section() { printf '\n%s== %s ==%s\n' "$BOLD" "$1" "$RESET"; }
ok()      { printf '  %s[OK]%s   %s\n'   "$GREEN"  "$RESET" "$1"; }
warn()    { printf '  %s[E’TIBOR]%s %s\n' "$YELLOW" "$RESET" "$1"; }
bad()     { printf '  %s[MUAMMO]%s %s\n' "$RED"    "$RESET" "$1"; }
info()    { printf '  %s\n' "$1"; }

have() { command -v "$1" >/dev/null 2>&1; }

# Xulosa uchun yig'iladigan javoblar
declare -a FINDINGS=()
add() { FINDINGS+=("$1"); }

printf '%s' "$BOLD"
cat <<'BANNER'
+---------------------------------------------------------------+
|  Data365 — server tekshiruvi (1-bosqich, faqat o'qiydi)       |
+---------------------------------------------------------------+
BANNER
printf '%s' "$RESET"
info "Vaqt: $(date '+%Y-%m-%d %H:%M:%S %Z')"
info "Server: $(hostname 2>/dev/null || echo '?')"

# -----------------------------------------------------------------------------
section "1. Operatsion tizim va yadro"
# -----------------------------------------------------------------------------
if [ -r /etc/os-release ]; then
	# shellcheck disable=SC1091
	. /etc/os-release
	info "OS: ${PRETTY_NAME:-noma'lum}"
	add "OS: ${PRETTY_NAME:-noma'lum}"
else
	warn "/etc/os-release o'qilmadi"
	add "OS: aniqlanmadi"
fi
info "Yadro: $(uname -r 2>/dev/null || echo '?')"
info "Arxitektura: $(uname -m 2>/dev/null || echo '?')"

if [ "$(id -u)" -eq 0 ]; then
	ok "root huquqi bor — hamma tekshiruv to'liq bajariladi"
	IS_ROOT=1
else
	warn "root emas ($(id -un)). Ba'zi tekshiruvlar chala bo'lishi mumkin."
	info "To'liq natija uchun: sudo bash 01-server-check.sh"
	IS_ROOT=0
fi

# -----------------------------------------------------------------------------
section "2. Resurslar — yadro, RAM, disk"
# -----------------------------------------------------------------------------
CORES=$(nproc 2>/dev/null || echo 0)
info "CPU yadrolari: $CORES"
if [ "$CORES" -ge 4 ]; then
	ok "Video siqish uchun yetarli (4+ yadro)"
elif [ "$CORES" -ge 2 ]; then
	warn "2-3 yadro: ishlaydi, lekin video siqish sekin bo'ladi"
else
	bad "1 yadro: video qayta ishlash uchun juda kam"
fi
add "CPU: ${CORES} yadro"

if have free; then
	RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
	RAM_FREE_MB=$(free -m | awk '/^Mem:/{print $7}')
	info "RAM: ${RAM_MB} MB jami, ${RAM_FREE_MB} MB bo'sh"
	if [ "${RAM_MB:-0}" -ge 7500 ]; then
		ok "RAM yetarli (8 GB+)"
	elif [ "${RAM_MB:-0}" -ge 3500 ]; then
		warn "4 GB: ishlaydi, lekin uzun yozuvlarni qayta ishlashda tor kelishi mumkin"
	else
		bad "4 GB dan kam — bu ilova uchun kam"
	fi
	add "RAM: ${RAM_MB} MB (bo'sh: ${RAM_FREE_MB} MB)"
else
	warn "free buyrug'i yo'q"
fi

if have df; then
	DISK_LINE=$(df -h / | awk 'NR==2')
	DISK_FREE=$(echo "$DISK_LINE" | awk '{print $4}')
	DISK_USED_PCT=$(echo "$DISK_LINE" | awk '{print $5}' | tr -d '%')
	info "Disk (/): ${DISK_FREE} bo'sh, ${DISK_USED_PCT}% band"
	if [ "${DISK_USED_PCT:-100}" -lt 70 ]; then
		ok "Disk joyi bemalol"
	elif [ "${DISK_USED_PCT:-100}" -lt 85 ]; then
		warn "Disk ${DISK_USED_PCT}% band — kuzatib turish kerak"
	else
		bad "Disk ${DISK_USED_PCT}% band — yangi ilova uchun joy tor"
	fi
	add "Disk: ${DISK_FREE} bo'sh (${DISK_USED_PCT}% band)"
fi

# -----------------------------------------------------------------------------
section "3. Docker"
# -----------------------------------------------------------------------------
if have docker; then
	DOCKER_V=$(docker --version 2>/dev/null || echo "?")
	ok "Docker o'rnatilgan: $DOCKER_V"
	add "Docker: bor ($DOCKER_V)"
	if docker ps >/dev/null 2>&1; then
		RUNNING=$(docker ps --format '{{.Names}}' 2>/dev/null | wc -l | tr -d ' ')
		info "Ishlab turgan konteynerlar: $RUNNING ta"
		if [ "${RUNNING:-0}" -gt 0 ]; then
			printf '%s' "$DIM"
			docker ps --format '    - {{.Names}}  ({{.Image}})' 2>/dev/null
			printf '%s' "$RESET"
			warn "Serverda boshqa narsalar ishlayapti — o'rnatishda ehtiyot bo'lamiz"
		fi
		add "Ishlayotgan konteynerlar: ${RUNNING} ta"
	else
		warn "docker ps ishlamadi (huquq yetishmaydi bo'lishi mumkin)"
	fi
else
	info "Docker o'rnatilmagan — biz o'rnatamiz (ruxsat so'raymiz)"
	add "Docker: yo'q"
fi

# -----------------------------------------------------------------------------
section "4. Coolify (ilovalarni boshqaruvchi panel)"
# -----------------------------------------------------------------------------
COOLIFY_FOUND=0
if have docker && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qi coolify; then
	COOLIFY_FOUND=1
fi
[ -d /data/coolify ] && COOLIFY_FOUND=1

if [ "$COOLIFY_FOUND" -eq 1 ]; then
	ok "Coolify topildi — biz shunchaki yangi ilova qo'shamiz, eng oson yo'l"
	add "Coolify: BOR (yangi o'rnatish shart emas)"
else
	info "Coolify topilmadi — o'rnatishimiz kerak bo'ladi"
	add "Coolify: yo'q (o'rnatiladi)"
fi

# -----------------------------------------------------------------------------
section "5. Portlar — 80 va 443 bo'shmi?"
# -----------------------------------------------------------------------------
port_user() {
	local p="$1"
	if have ss; then
		ss -lntp 2>/dev/null | awk -v p=":$p\$" '$4 ~ p {print $NF; exit}'
	elif have netstat; then
		netstat -lntp 2>/dev/null | awk -v p=":$p\$" '$4 ~ p {print $NF; exit}'
	fi
}
for P in 80 443; do
	USER_OF=$(port_user "$P")
	if [ -n "$USER_OF" ]; then
		warn "Port $P band: $USER_OF"
		add "Port $P: BAND ($USER_OF)"
	else
		ok "Port $P bo'sh"
		add "Port $P: bo'sh"
	fi
done
if [ -n "$(port_user 80)" ] || [ -n "$(port_user 443)" ]; then
	info "Band bo'lsa ham muammo emas — ikkala sayt bitta proksi orqali ishlaydi,"
	info "faqat bu qo'shimcha ish, shuning uchun bilishimiz kerak edi."
fi

# -----------------------------------------------------------------------------
section "6. Tashqi aloqa (ilova ishlashi uchun kerak)"
# -----------------------------------------------------------------------------
check_url() {
	local name="$1" url="$2"
	if have curl; then
		if curl -fsS -m 10 -o /dev/null "$url" 2>/dev/null; then
			ok "$name — aloqa bor"
			add "$name: OK"
		else
			bad "$name — aloqa yo'q yoki bloklangan"
			add "$name: ULANMADI"
		fi
	else
		warn "curl yo'q, $name tekshirilmadi"
	fi
}
check_url "GitHub (kodni olish)"        "https://github.com"
check_url "Cloudflare R2 (videolar)"    "https://cloudflare.com"
check_url "Google AI (Gemini)"          "https://generativelanguage.googleapis.com"
check_url "DuckDNS (sayt manzili)"      "https://www.duckdns.org"

# -----------------------------------------------------------------------------
section "7. Tashqi IP manzil"
# -----------------------------------------------------------------------------
if have curl; then
	PUB_IP=$(curl -fsS -m 10 https://api.ipify.org 2>/dev/null || echo "")
	if [ -n "$PUB_IP" ]; then
		info "Serverning tashqi IP manzili: $PUB_IP"
		info "Sayt manzili (data365.duckdns.org) shu IP'ga qaratiladi."
		add "Tashqi IP: $PUB_IP"
	else
		warn "Tashqi IP aniqlanmadi"
	fi
fi

# -----------------------------------------------------------------------------
section "XULOSA — shu qismni nusxalab bizga yuboring"
# -----------------------------------------------------------------------------
printf '\n%s----- NUSXALASH SHU YERDAN BOSHLANADI -----%s\n' "$BOLD" "$RESET"
echo "DATA365 SERVER TEKSHIRUVI — $(date '+%Y-%m-%d %H:%M')"
for f in "${FINDINGS[@]}"; do echo "  $f"; done
printf '%s----- NUSXALASH SHU YERDA TUGAYDI -----%s\n\n' "$BOLD" "$RESET"

info "Bu skript hech narsani o'zgartirmadi. Serveringiz qanday bo'lsa, shundayligicha qoldi."
info "Yuqoridagi xulosani bizga yuboring — keyingi bosqichni shunga qarab tayyorlaymiz."
