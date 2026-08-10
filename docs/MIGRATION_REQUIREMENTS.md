# Ko'chirish uchun nima kerak — mijoz uchun ro'yxat

_Ustoz (data365) ilovasini **jamoaning o'z Contabo serveriga** ko'chirish. Qayta yozilgan: 2026-08-10._
_Tasdiqlangan manba: `.env.example` (23 ta sozlama) + `docs/RUNBOOK.md` (hozirgi server sozlamasi)._

> **2026-08-10 da yo'nalish o'zgardi: Railway EMAS, jamoaning Contabo serveri.**
> Eski Railway rejasi (`docs/plans/2026-07-29-railway-migration-plan.md`) endi amal qilmaydi —
> uni "keyingi qadam" deb o'qimang. Nima o'zgargani va nega, quyida.

---

## 0-QISM — "Shunchaki serverni berib qo'ysak bo'ladimi?" — YO'Q, va sababi

Contabo **bitta serverni** boshqa akkauntga o'tkazmaydi. Ularning o'z qoidasi:
_"it is only possible to transfer your entire account as a whole; it is not possible to
transfer a single instance"_ — ya'ni faqat **butun akkaunt**, ikkala tomon imzolagan
"Transfer of Contract" formasi bilan
([manba](https://help.contabo.com/en/support/solutions/articles/103000269442-can-i-transfer-my-account-to-someone-else-)).
Bizning akkauntda boshqa narsalar ham bo'lgani uchun bu yo'l yopiq.

**Lekin bu endi muhim emas:** jamoaning **allaqachon o'z Contabo serveri bor**, demak biz
o'sha serverga o'rnatamiz. Qayta deploy shart — undan qochib bo'lmaydi. Yaxshi tomoni:
stack bir xil (Coolify + Docker + MySQL), ya'ni **yangidan qurish emas, nusxa ko'chirish**.
Railway rejasidan sezilarli oson.

---

## 1-QISM — MIJOZDAN KERAK (siz shuni so'raysiz)

Bu uchtasi bo'lmasa ko'chirishni boshlab bo'lmaydi.

| # | Nima | Qayerdan | Nega kerak |
|---|---|---|---|
| 1 | **Serverga kirish huquqi** — SSH kaliti yoki root parol + IP manzil | Ularning Contabo boshqaruv panelidan | Ilovani o'rnatish uchun. Bizga doimiy root kerak emas — o'rnatib bo'lgach ular kalitni olib qo'yishlari mumkin |
| 2 | **Cloudflare R2**: `ustoz-videos` nomli bucket + **API token** | cloudflare.com → R2 | Videolar shu yerda yotadi. Token'dan **2 ta kalit** chiqadi (access + secret) — ikkalasi ham kerak |
| 3 | **Gemini API kaliti** | aistudio.google.com/app/apikey | AI tahlil. Shundan keyin AI puli mijoznikidan ketadi (o'lchangan: o'tgan oy $7.27, bu oy 10 kunda $1.45) |

**Railway va MySQL endi ro'yxatda yo'q** — server ularniki bo'lgani uchun bazani biz
o'sha serverning ichida (Coolify MySQL) ko'taramiz, alohida xizmat sotib olinmaydi.

---

## 1b-QISM — SERVER HAQIDA BILISHIMIZ KERAK (javobsiz reja aniq bo'lmaydi)

Egasi javob bermaguncha bu **taxmin**, shuning uchun alohida ajratildi. Mijozdan so'raladigan
aniq savollar:

1. **Serverda hozir nima ishlayapti?** (Egasining o'zi "katta ehtimol boshqa loyihalar ham
   bor" dedi — shuning uchun bu birinchi savol.)
2. **Coolify o'rnatilganmi?** Bo'lsa — biz shunchaki yangi ilova qo'shamiz. Bo'lmasa —
   o'rnatamiz, lekin bu serverdagi mavjud narsalarga tegadi, ruxsat so'raymiz.
3. **80 va 443-portlar bandmi?** Ya'ni u yerda allaqachon veb-sayt bormi. Band bo'lsa,
   ikkala ilova bitta proksi orqali ishlashi kerak — qo'shimcha ish, lekin bajariladi.
4. **Nechta yadro, qancha RAM, qancha bo'sh disk?** Video siqish og'ir ish: hozirgi server
   buni bemalol bajaradi, lekin biz yangisining o'lchamini bilishimiz kerak.
5. **Docker bormi va boshqa loyihalar ham Docker'damiz?**

**Ochiq xavf, oldindan aytilyapti:** server ular bilan bo'lishilgan bo'lsa, birovning boshqa
loyihasi butun serverni yiqitsa, bizning ilova ham yiqiladi. Bu texnik kamchilik emas,
shunchaki haqiqat — bilib turib qaror qilinsin.

---

## 2-QISM — BIZ TO'LDIRAMIZ (mijozdan so'ramaysiz)

- **Maxfiy kalitlar** (biz yaratamiz): `NEXTAUTH_SECRET`, `DATABASE_ENCRYPTION_KEY`, `INVITE_TOKEN_SECRET`, `CRON_SECRET`
- **Manzillar**: `NEXTAUTH_URL`, `WEB_URL`, `NEXT_PUBLIC_WEB_URL` — **`https://data365.duckdns.org` o'zgarmaydi** (3-qismga qarang)
- **Bazaga ulanish**: `DATABASE_URL` — Coolify MySQL ko'tarilganda hosil bo'ladi
- **Saqlash sozlamalari** (1-qismdagi R2 kalitlaridan): `CAP_AWS_ACCESS_KEY`, `CAP_AWS_SECRET_KEY`, `CAP_AWS_ENDPOINT`, `CAP_AWS_BUCKET`, `CAP_AWS_REGION`, `S3_PATH_STYLE`, `CLOUDFLARE_R2_ACCOUNT_ID`, `CLOUDFLARE_R2_ACCESS_KEY`, `CLOUDFLARE_R2_SECRET_KEY`, `CLOUDFLARE_R2_BUCKET`
- **Birinchi admin**: `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` — bir marta ishlatiladi, keyin parol almashtiriladi
- **Qolgani**: `NEXT_PUBLIC_DOCKER_BUILD`, `CAP_VIDEOS_DEFAULT_PUBLIC`

**Bazada `awsBucket` ustuni har bir qatorda bo'sh** (2026-08-07 da tekshirilgan) — demak
bucket faqat ENV'dan olinadi va bazani qayta yozish kerak emas.

---

## 3-QISM — BIZNING ISHIMIZ (ko'chirish paytida)

1. **Manzil o'zgarmaydi: `data365.duckdns.org`.** Faqat DuckDNS'dagi IP yangi serverga
   qaratiladi. Buning natijasi:
   - **jamoa kengaytmani QAYTA O'RNATMAYDI** — eski rejada bu bor edi, endi kerak emas;
   - **eski share-linklar ishlayveradi** — tarqatilgan havolalar buzilmaydi.
   - _Halol eslatma:_ bu nom bizning DuckDNS yozuvimiz. To'liq mustaqillik kerak bo'lsa,
     keyinchalik ularning o'z domeniga o'tkaziladi — o'shanda kengaytma qayta yig'iladi.
2. **Videolar (0.49 GB) yangi Cloudflare R2 akkauntiga ko'chiriladi** va **har biri ochilishi
   bittalab tekshiriladi**, ro'yxat bilan.
3. **Baza ko'chiriladi** — 12 ta yozuv (jami 7 soat 40 daqiqa), 3 foydalanuvchi, 1 tashkilot,
   2 papka, 11 izoh. **O'chirilgan 18 ta yozuv ko'chirilmaydi.**
4. **Yangi admin hisob** ochiladi.
5. **`docs/RUNBOOK.md` qayta yoziladi** — yangi server, yangi IP, yangi kalitlar; yangi odam
   ham deploy va rollback qila olsin.

**Xotira hisobi:** video fayllari **0.49 GB**. Bunga qo'shimcha rasmchalar va transkriptlar —
bir necha yuz MB. 5 GB bo'lsa ham yetadi; 2 soatlik uchrashuv ~120 MB.

---

## 4-QISM — KAFOLAT

- **Eski server ham, eski videolar ham hech qachon o'chirilmaydi** — yangi joyda hamma video
  ochilayotgani isbotlanmaguncha.
- O'chirish kerak bo'lganda **alohida so'raladi**, o'z-o'zidan bo'lmaydi.

---

## OGOHLANTIRISH — endi narx emas, boshqa narsa

Eski hujjatdagi "Railway ishlatilganiga qarab hisoblaydi, hisob qimmat chiqishi mumkin"
ogohlantirishi **endi amal qilmaydi va olib tashlandi** — Contabo oyiga qat'iy summa oladi.

O'rniga ikkita haqiqiy xavf:
1. **Bo'lishilgan server.** Boshqa loyiha serverni yiqitsa yoki diskni to'ldirsa, bu ilova
   ham to'xtaydi. 1b-qismdagi savollar shuning uchun.
2. **AI xarajati ularga o'tadi.** O'lchangan: oyiga $1.45–$7.27. Ko'p yozuv qilinsa ko'proq.
   Kerak bo'lsa "arzon rejim" bor — bepul kvota kutiladi, tezlik o'rniga pul tejaladi.
