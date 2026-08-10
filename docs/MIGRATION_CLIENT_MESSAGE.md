# Mijozga yuboriladigan xabar (tayyor matn — nusxa oling va jo'nating)

_Qayta yozilgan 2026-08-10. Eski versiya Railway uchun edi va **endi noto'g'ri** —
yo'nalish o'zgardi: jamoaning o'z Contabo serveri._
_Bu xabar bilan birga **ikkita fayl** yuboriladi (pastda). Batafsil texnik ro'yxat:
`MIGRATION_REQUIREMENTS.md` — u faqat biz uchun, mijozga yuborilmaydi._

---

## Yuboriladigan fayllar

| Fayl | Kimga | Nima qiladi |
|---|---|---|
| `docs/migration/data365-kochirish.html` | **Odamga** — brauzerda ochadi | Qadam-baqadam qo'llanma, belgilab boriladigan ro'yxat bilan |
| `docs/migration/01-server-check.sh` | **Serverga** | Serverni faqat **o'qiydi**, hisobot chiqaradi. Hech narsani o'zgartirmaydi |

---

## Xabar matni

Assalomu alaykum.

Ilovani sizning o'z serveringizga ko'chirishga tayyormiz.

Ikkita fayl biriktirdim:

**1. `data365-kochirish.html`** — buni brauzerda oching (ikki marta bosing). Ichida
hamma narsa qadam-baqadam yozilgan: nima kerak, qayerdan olinadi, nima uchun kerak.
Bajarganingizni belgilab borasiz.

**2. `01-server-check.sh`** — bu serveringiz uchun. **Muhim:** bu skript serverda
hech narsani o'zgartirmaydi, o'rnatmaydi va o'chirmaydi — u faqat serverni o'qiydi
(qancha xotira bor, nima ishlayapti, portlar bo'shmi) va ekranga hisobot chiqaradi.
Ishga tushirishdan oldin faylni oddiy matn sifatida o'zingiz o'qib chiqishingiz mumkin,
biz buni tavsiya ham qilamiz.

Serverga qo'yib, shunday ishga tushiring:

```
bash 01-server-check.sh
```

Oxirida «NUSXALASH SHU YERDAN BOSHLANADI» deb yozilgan qismni nusxalab menga yuboring.
Serveringizni ko'rmasdan turib aniq reja tuzib bo'lmaydi — shu hisobot bizga o'shani beradi.

**Sizdan jami uchta narsa kerak bo'ladi** (hammasi HTML faylda batafsil yozilgan):
serverga kirish, Cloudflare R2 ombori, va Gemini kaliti. Qolgan 19 ta sozlamani biz
to'ldiramiz.

**Ikkita yaxshi xabar:** sayt manzili (`data365.duckdns.org`) o'zgarmaydi, shuning uchun
**jamoangiz brauzer kengaytmasini qayta o'rnatmaydi** va avval tarqatilgan havolalar
ishlayveradi.

**Kafolat:** eski serverdagi hech narsa o'chirilmaydi — yangi joyda hamma yozuv
ochilayotgani bittalab isbotlanmaguncha. O'chirish kerak bo'lganda alohida so'raymiz.

Kalitlarni tayyor bo'lganda xavfsiz tarzda yuboring — oddiy xabarda emas.

---

## Nima uchun "serverni shunchaki o'tkazib qo'yish" bo'lmaydi (savol bersa)

Contabo bitta serverni boshqa akkauntga o'tkazmaydi — faqat **butun akkauntni**,
ikkala tomon imzolagan forma bilan
([manba](https://help.contabo.com/en/support/solutions/articles/103000269442-can-i-transfer-my-account-to-someone-else-)).
Shuning uchun ularning o'z serveriga o'rnatamiz. Stack bir xil bo'lgani uchun bu
yangidan qurish emas, nusxa ko'chirish.
