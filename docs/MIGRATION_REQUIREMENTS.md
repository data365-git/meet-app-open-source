# Ko'chirish uchun nima kerak — mijoz uchun ro'yxat

_Ustoz (data365) ilovasini mijozning o'z serveriga ko'chirish. Yozilgan: 2026-08-04._
_Tasdiqlangan manba: `.env.example` (23 ta sozlama) + `docs/plans/2026-07-29-railway-migration-plan.md`._

---

## 1-QISM — MIJOZ OCHADI (siz shuni so'raysiz)

Bu to'rttasi bo'lmasa ko'chirishni boshlab bo'lmaydi.

| # | Nima | Qayerdan | Nega kerak |
|---|---|---|---|
| 1 | **Railway hisobi + bitta loyiha** | railway.com | Ilova shu serverda ishlaydi |
| 2 | **Railway loyihasiga MySQL qo'shish** | Railway ichida "+ New" → Database → MySQL | Baza. Alohida so'ramaysiz — Railway o'zi ulaydi |
| 3 | **Cloudflare R2**: `ustoz-videos` nomli bucket + **API token** | cloudflare.com → R2 | Videolar shu yerda yotadi. Token'dan **2 ta kalit** chiqadi (access + secret) — ikkalasi ham kerak |
| 4 | **Gemini API kaliti** | aistudio.google.com/app/apikey | AI tahlil. Shundan keyin AI puli mijoznikidan ketadi (hozir ~$7/oy) |

**Xotira hisobi (2026-08-07 da qayta o'lchandi — eski "3.4 GB" raqami eskirgan).** Ko'chiriladigan asosiy yuk: **12 ta yozuv, jami 7 soat 40 daqiqa, video fayllari 0.49 GB.** Kamayishining sababi: siqilmagan ikkita yozuv siqildi (970 MB tejaldi) va bittasi audioga aylantirildi. Bunga qo'shimcha: rasmchalar, transkriptlar va eski nusxalar — ular bir necha yuz MB. **O'chirilgan 18 ta yozuvning fayllari ko'chirilmaydi** (ular allaqachon o'chirilgan, yangi joyga tashib yurishning ma'nosi yo'q). Mijozda 5 GB bo'lsa ham yetadi; 2 soatlik uchrashuv ~120 MB.

---

## 2-QISM — BIZ TO'LDIRAMIZ (mijozdan so'ramaysiz)

Qolgan sozlamalarni biz o'zimiz yozamiz yoki generatsiya qilamiz:

- **Maxfiy kalitlar** (biz yaratamiz): `NEXTAUTH_SECRET`, `DATABASE_ENCRYPTION_KEY`, `INVITE_TOKEN_SECRET`, `CRON_SECRET`
- **Manzillar** (Railway bergan domendan): `NEXTAUTH_URL`, `WEB_URL`, `NEXT_PUBLIC_WEB_URL`
- **Bazaga ulanish**: `DATABASE_URL` — Railway MySQL qo'shilganda o'zi paydo bo'ladi
- **Saqlash sozlamalari** (3-qismdagi kalitlardan): `CAP_AWS_ACCESS_KEY`, `CAP_AWS_SECRET_KEY`, `CAP_AWS_ENDPOINT`, `CAP_AWS_BUCKET`, `CAP_AWS_REGION`, `S3_PATH_STYLE`, `CLOUDFLARE_R2_ACCOUNT_ID`, `CLOUDFLARE_R2_ACCESS_KEY`, `CLOUDFLARE_R2_SECRET_KEY`, `CLOUDFLARE_R2_BUCKET`
- **Birinchi admin**: `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` — bir marta ishlatiladi, keyin parol almashtiriladi
- **Qolgani**: `NEXT_PUBLIC_DOCKER_BUILD`, `CAP_VIDEOS_DEFAULT_PUBLIC`

---

## 3-QISM — BIZNING ISHIMIZ (ko'chirish paytida)

1. **12 ta video + baza** (3 foydalanuvchi, 1 tashkilot, 2 papka, 11 izoh) ko'chiriladi va **har biri ochilishi tekshiriladi** — bittalab, ro'yxat bilan
2. **Kengaytma qayta yig'iladi** — ichida eski manzil (`data365.duckdns.org`) yozilgan, yangi manzilga o'zgaradi
3. **Jamoa bir marta kengaytmani qayta o'rnatadi** — bu yagona narsa, ular sezadi
4. **Yangi admin hisob** ochiladi
5. **Deploy/rollback qo'llanmasi qayta yoziladi** — hozirgisi eski serverga mos, yangi odam ham qila olsin

---

## 4-QISM — KAFOLAT

- **Eski server ham, eski videolar ham hech qachon o'chirilmaydi** — yangi joyda hamma video ochilayotgani isbotlanmaguncha.
- O'chirish kerak bo'lganda **alohida so'raladi**, o'z-o'zidan bo'lmaydi.

---

## OGOHLANTIRISH — narx shakli o'zgaradi

Hozirgi server **oyiga qat'iy summa**. Railway esa **ishlatilganiga qarab** hisoblaydi, bu ilova esa video qayta ishlash va uzoq AI ishlarini bajaradi. Ya'ni arzonroq ham, bir necha barobar qimmatroq ham chiqishi mumkin. Ko'chirgandan keyin **birinchi oy hisobni kuzatish shart**.
