# Egasi uchun tekshiruv qo'llanmasi — meeting yozib olish

Sana: 2026-07-18 · Kim uchun: loyiha egasi (dasturchi emas) · Qayerda: **noutbukdagi Chrome**

---

## Buni nega siz qilyapsiz

Men (Claude) mashina qila oladigan hamma tekshiruvni qildim: testlar, kod tekshiruvi,
qurish. Lekin bitta narsani hech qanday test isbotlay olmaydi:

> **Haqiqiy Meet'da suhbatdoshingizning ovozi yozuvda eshitiladimi?**

Buni faqat tirik odam, tirik mikrofon va tirik uchrashuv isbotlaydi. Shuning uchun
quyidagi qadamlar sizda.

**Qoida:** har bir qadamda faqat bitta ish qiling. Kutilgani chiqmasa — **to'xtang**
va menga nima ko'rganingizni ayting. "Ishlamadi" yetarli emas; ekranda nima
yozilganini ayting.

---

## 0-qadam — Extension'ni yangilash (1 daqiqa)

1. Chrome'da manzil qatoriga yozing: `chrome://extensions`
2. O'ng yuqorida **Developer mode** tugmasi yoqilgan bo'lsin.
3. **Load unpacked** bosing → shu papkani tanlang:
   `D:\vibecoding\ustoz-github\apps\browser-extension\dist`
4. Agar u allaqachon turgan bo'lsa — uning ustidagi **🔄 (Reload)** belgisini bosing.

✅ **Ko'rishingiz kerak:** ro'yxatda extension turibdi, versiyasi yozilgan, qizil
xato yozuvi yo'q.
❌ **Xato bo'lsa:** qizil "Errors" tugmasi chiqadi. Bosing, matnini menga yuboring.

---

## 1-qadam — ⭐ ASOSIY TEKSHIRUV: 3 daqiqalik yozuv (yolg'iz, 5 daqiqa)

Bu eng muhimi. Faqat shu o'tsa, qolganlari mayda-chuyda.

1. `meet.google.com` ga kiring → **New meeting** → **Start an instant meeting**.
   (Hech kim kerak emas, o'zingiz yolg'iz.)
2. Chrome'ning o'ng yuqorisidagi extension belgisini bosing.
3. **Record** tugmasini bosing.
4. Chrome oyna ochadi — **Entire Screen** bo'limini tanlang, ekranni bosing,
   va **pastdagi "Also share system audio" katagini albatta belgilang**.
   Keyin **Share** bosing.
5. Bir necha jumla gapiring. **3 daqiqa** kuting.
6. Extension'ni ochib **Stop** bosing.
7. Yuklanishini kuting → `https://data365.duckdns.org` dashboard'ni oching.

✅ **Ko'rishingiz kerak:** yozuv ro'yxatda paydo bo'ladi → uni ochasiz →
**oxirigacha o'ynaydi** va **o'z ovozingiz eshitiladi**. Davomiyligi ~3 daqiqa.

Qo'shimcha (siz so'ragan avto-ochiq): yozuvning **Share havolasini** nusxalab,
Chrome'ning **Incognito** oynasida oching (login'siz). Video o'sha yerda ham
o'ynashi kerak — endi har yangi yozuv havola orqali darhol ochiq.
❌ **Xato bo'lsa:** yozuv umuman chiqmasa · ochilmasa · yarmida to'xtasa ·
davomiyligi noto'g'ri bo'lsa (masalan 3 daqiqa yozdingiz, 40 soniya chiqdi) ·
ovoz umuman yo'q bo'lsa.

---

## 2-qadam — Noto'g'ri tanlov rad etiladimi (1 daqiqa)

Bu men bugun tuzatgan asosiy xato. Ilgari siz **tab** tanlasangiz ham yozuv
boshlanaverar edi — va suhbatdosh ovozi yozilmasdi.

1. Yana Meet oching → extension → **Record**.
2. Chrome oynasida ataylab **noto'g'ri** tanlang: **Chrome Tab** bo'limidan bitta
   tab tanlab **Share** bosing.

✅ **Ko'rishingiz kerak:** yozuv **boshlanmaydi**. "To'liq ekranni tanlang" degan
mazmunda ogohlantirish chiqadi va tanlash oynasi qaytadan so'raladi.
❌ **Xato bo'lsa:** yozuv baribir boshlanib ketsa — bu tuzatilmaganini bildiradi.

Keyin **Entire Screen** tanlab davom eting va **Stop** bosing (bu yozuv kerak emas).

---

## 3-qadam — Pauza rostini gapiradimi (2 daqiqa)

1. Yozuvni boshlang (1-qadamdagidek, Entire Screen).
2. 20 soniya gapiring → **Pause** bosing.
3. Pauza paytida **balandroq ovozda sanang: "bir, ikki, uch..."** — 15 soniya.
4. **Resume** bosing → yana 20 soniya gapiring → **Stop**.

✅ **Ko'rishingiz kerak:** pauza paytida taymer **to'xtab turadi**. Tayyor yozuvda
"bir, ikki, uch" sanog'i **eshitilmaydi** — u qismi tushib qolgan bo'lishi kerak.
❌ **Xato bo'lsa:** taymer pauzada ham yurib tursa · yoki sanoq yozuvda eshitilsa
(demak "pauza" degan yozuv yolg'on bo'lgan).

---

## 4-qadam — Internet uzilsa yozuv yo'qoladimi (3 daqiqa)

Eng qo'rqinchli holat: yozib turganda internet uzildi.

1. Yozuvni boshlang → 1 daqiqa gapiring.
2. **Wi-Fi'ni o'chiring** (yoki internet kabelini uzing).
3. Yana 30 soniya gapiring → **Stop** bosing.
4. Chrome'ni **butunlay yoping** (hamma oynasini).
5. Wi-Fi'ni yoqing → Chrome'ni qaytadan oching → 2 daqiqa kuting.
6. Dashboard'ni oching.

✅ **Ko'rishingiz kerak:** yozuv o'zi paydo bo'ladi va **oxirigacha** o'ynaydi —
internet uzilgandan keyin gapirgan 30 soniyangiz ham ichida bo'ladi.
❌ **Xato bo'lsa:** yozuv umuman kelmasa · yoki internet uzilgan joyda kesilib
qolsa · yoki "yo'qoldi" degan xabar chiqsa.

---

## 5-qadam — O'chirish rostdan o'chiradimi (2 daqiqa)

1. Qisqa yozuv qiling (30 soniya) → **Stop**.
2. Yuklanayotganda **Permanently discard** (butunlay o'chirish) ni tanlang.
3. Tasdiqlashni so'raydi — tasdiqlang.
4. Dashboard'ni oching.

✅ **Ko'rishingiz kerak:** "Deleted" (o'chirildi) **yoki** "Delete queued; will
retry" (o'chirish navbatga qo'yildi) — ikkalasidan biri aniq yoziladi. Dashboard'da
bu yozuv yo'q.
❌ **Xato bo'lsa:** hech narsa yozilmasa · yoki "o'chirildi" desa-yu dashboard'da
turgan bo'lsa.

---

## 6-qadam — ⭐⭐ ENG MUHIMI: suhbatdoshning ovozi (ikki kishi kerak)

**Bu loyihaning #1 talabi.** Buni mendan boshqa hech kim, hech qanday test
bajarolmaydi — ikkinchi odam kerak (telefon ham bo'ladi).

1. Meet oching → havolani ikkinchi odamga (yoki o'z telefoningizga) yuboring.
2. U kirsin. **Uning mikrofoni yoqiq** bo'lsin, sizniki ham.
3. Yozuvni boshlang (Entire Screen + system audio kataklari belgilangan).
4. **Unga aytiliring:** o'ziga xos bitta jumla aytsin — masalan
   **"olma daraxti to'qqiz"**. Shunday so'z tanlangki, tasodifan chiqmasin.
5. Siz ham bir nima ayting. 2 daqiqa yozing → **Stop**.
6. Dashboard'da yozuvni oching va **quloq soling**.

✅ **O'tdi hisoblanadi:** yozuvda **"olma daraxti to'qqiz"** aniq eshitiladi.
❌ **Yiqildi:** faqat o'z ovozingiz eshitilsa, uniki yo'q bo'lsa. Bu — deploy
qilib bo'lmaydigan holat, chunki mahsulotning butun ma'nosi shu.

---

## Yakunda menga nima ayting

Har bir qadam uchun bitta so'z yetadi:

```
0-qadam: ha / yo'q
1-qadam: ha / yo'q
2-qadam: ha / yo'q
3-qadam: ha / yo'q
4-qadam: ha / yo'q
5-qadam: ha / yo'q
6-qadam: ha / yo'q / hali qilmadim
```

"Yo'q" bo'lsa — **ekranda nima yozilganini** qo'shing.

**Deploy qilish qarori:** 1-qadam va 6-qadam o'tmaguncha deploy qilmaymiz. Qolgan
qadamlar yiqilsa — muhim, lekin to'xtatuvchi emas; men tuzataman.
