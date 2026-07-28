# Egasi uchun tekshiruv qo'llanmasi — meeting yozib olish (v0.5.6)

Sana: 2026-07-22 · Kim uchun: loyiha egasi (dasturchi emas) · Qayerda: **noutbukdagi Chrome**

> **Extension endi faqat inglizcha.** Ekranda ko'radigan tugma/ogohlantirishlarni quyida
> tirnoq ichida ("...") aynan qanday yozilishini ko'rsatdim — shu matnni izlang.

---

## Buni nega siz qilyapsiz

Men (Claude) mashina qila oladigan hamma tekshiruvni qildim: testlar, kod tekshiruvi,
qurish, prod'ga chiqarish (v0.5.6 tirik). Lekin bitta narsani hech qanday test isbotlay olmaydi:

> **Haqiqiy Meet'da suhbatdoshingizning ovozi yozuvda eshitiladimi — va bitta qo'ng'iroqda
> IKKINCHI marta yozganda ham eshitiladimi?**

Aynan shu ikkinchisi bu safar tuzatilgan asosiy xato edi. Buni faqat tirik odam, tirik
mikrofon va tirik uchrashuv isbotlaydi. Shuning uchun quyidagi qadamlar sizda.

**Qoida:** har bir qadamda faqat bitta ish qiling. Kutilgani chiqmasa — **to'xtang**
va menga nima ko'rganingizni ayting. "Ishlamadi" yetarli emas; ekranda nima
yozilganini ayting.

---

## 0-qadam — Extension'ni yangilash (2 daqiqa)

1. `https://data365.duckdns.org/dashboard/extension` ni oching → **zip'ni yuklab
   oling** va uni papkaga chiqaring (unzip).
2. Chrome'da manzil qatoriga yozing: `chrome://extensions`
3. O'ng yuqorida **Developer mode** yoqiq bo'lsin.
4. Eski "data365 Recorder" ni **Remove** qiling (eskisi qolsa, ikkitasi urishadi).
5. **Load unpacked** bosing → yangi chiqargan papkani tanlang.

✅ **Ko'rishingiz kerak:** ro'yxatda **data365 Recorder 0.5.6** turibdi, qizil xato
yo'q. Versiya **0.5.6** bo'lishi SHART — 0.5.5 yoki undan pasti bo'lsa eski kodni sinayapsiz.
❌ **Xato bo'lsa:** qizil "Errors" tugmasi chiqadi. Bosing, matnini menga yuboring.

---

## 1-qadam — ⭐ ASOSIY: 3 daqiqalik yozuv (yolg'iz, 5 daqiqa)

Bu birinchi darvoza. Faqat shu o'tsa, keyingisiga o'tamiz.

Meet sahifasining o'zida karta chiqadi — extension belgisini bosish shart emas.

1. `meet.google.com` ga kiring → **New meeting** → **Start an instant meeting**.
   (Hech kim kerak emas, o'zingiz yolg'iz.)
2. Ekran yuqorisida **"Record this meeting?"** kartasi chiqadi. Ostida maslahat
   yozuvi bor: *"...choose 'Entire Screen' and turn on 'Share system audio'..."*.
   **"Record now"** tugmasini bosing.
   *(Karta chiqmasa: sahifani yangilang — yoki eski yo'l **Ctrl+Shift+9**, u ham ishlaydi.)*
3. Chrome darrov tanlash oynasini ochadi → **Entire Screen** ni tanlang → pastda
   **"Share system audio"** (yoki "Also share tab/system audio") **katagini belgilang** →
   ekranni bosing → **Share** bosing.
4. Bir necha jumla gapiring. **3 daqiqa** kuting.
5. Ekran yuqorisidagi qizil taymerdagi **"Stop"** ni bosing → **"Recording saved!"** chiqadi.
6. Yuklanishini kuting → `https://data365.duckdns.org` dashboard'ni oching.

✅ **Ko'rishingiz kerak:** yozuv ro'yxatda paydo bo'ladi → uni ochasiz →
**oxirigacha o'ynaydi** va **o'z ovozingiz eshitiladi**. Davomiyligi ~3 daqiqa.
❌ **Xato bo'lsa:** yozuv umuman chiqmasa · ochilmasa · yarmida to'xtasa ·
davomiyligi noto'g'ri bo'lsa · ovoz umuman yo'q bo'lsa.

---

## 2-qadam — ⭐⭐ ENG MUHIMI: suhbatdosh ovozi + IKKINCHI yozuv (ikki kishi kerak)

**Bu loyihaning #1 talabi va bu sessiyada tuzatilgan xato.** Ikkinchi odam kerak
(telefon ham bo'ladi). Bitta qo'ng'iroqda **ikki marta** yozamiz.

**Tayyorlash:**
1. Meet oching → havolani ikkinchi odamga (yoki o'z telefoningizga) yuboring. U kirsin.
   **Uning mikrofoni yoqiq** bo'lsin, sizniki ham.

**Birinchi yozuv:**
2. **"Record now"** → **Entire Screen** + **"Share system audio"** katagi belgilangan → Share.
3. **Suhbatdoshingizga ayting:** o'ziga xos bitta jumla aytsin — masalan
   **"olma daraxti to'qqiz"**. Tasodifan chiqmaydigan so'z tanlang.
4. Siz ham bir nima ayting. **2 daqiqa** yozing → **"Stop"**.

**Ikkinchi yozuv — SHU O'SHA qo'ng'iroqni yopmasdan:**
5. O'sha Meet sahifasida yana **"Record now"** → **Entire Screen** + **"Share system audio"** → Share.
6. Suhbatdoshingiz **boshqa** o'ziga xos jumla aytsin — masalan **"ko'k qush yetti"**.
7. **1-2 daqiqa** yozing → **"Stop"**.

**Tekshirish:**
8. Dashboard'da **ikkala** yozuvni oching va **quloq soling**.

✅ **O'tdi hisoblanadi:**
   - 1-yozuvda **"olma daraxti to'qqiz"** aniq eshitiladi.
   - 2-yozuvda **"ko'k qush yetti"** aniq eshitiladi.
   - 2-yozuvni boshlaganda **"The other person's audio wasn't captured"** ogohlantirishi
     **CHIQMASLIGI** kerak. (Agar *"...being recorded via system audio"* deb yozsa —
     bu **yaxshi**, xato emas: ovoz yozilyapti.)
❌ **Yiqildi:** biror yozuvda faqat o'z ovozingiz eshitilsa, suhbatdoshniki yo'q bo'lsa ·
   yoki 2-yozuvda **"...audio wasn't captured"** chiqib, keyin uning ovozi yozuvda bo'lmasa.
   Bu — deploy qilib bo'lmaydigan holat, chunki mahsulotning butun ma'nosi shu.

---

## 2b-qadam — ⭐⭐ YANGI: yozuv ketayotganda Meet oynalarini ochish (2 daqiqa)

_Nega: 2026-07-28 da egasi topgan xato — yozuv ketayotganda **"Add people"** oynasi
ochilsa, yozuv to'xtab qolar edi. Yozuv yangi bo'lsa **"Upload failed — Recording was
too short"** chiqardi; bir daqiqadan keyin bo'lsa jimgina to'xtardi. v0.5.6 shuni
tuzatadi, shuning uchun bu qadam endi majburiy._

1. Meet'da yozuvni boshlang (1-qadamdagidek).
2. **30 soniya** kuting — pill (yashil chizimcha) vaqtni sanayotganini ko'ring.
3. Meet'ning **"Add people"** oynasini oching va uni **kamida 10 soniya ochiq
   ushlab turing**, keyin yoping.
4. Yana 30 soniya gapirib turing → **"Stop"**.

✅ **Ko'rishingiz kerak:** oyna ochilganda ham pill sanashda **davom etadi** · hech
   qanday xato oynasi chiqmaydi · Stop bosgach yozuv Meetings ro'yxatida to'liq
   (~1 daqiqa) ko'rinadi va ochilganda o'ynaydi.
❌ **Yiqildi:** oyna ochilishi bilan (yoki bir necha soniyadan keyin) yozuv to'xtasa,
   yoki "too short" xatosi chiqsa. **Bunda `opera://extensions` (yoki
   `chrome://extensions`) → "service worker" → Console rasmini oling** — u yerda
   `[sw] ... Meet call ended` deb yozilgan bo'lsa, sabab boshqa yo'l ekan, menga
   ayting.

---

## 3-qadam — Noto'g'ri tanlov rad etiladimi (1 daqiqa, ixtiyoriy)

1. Yana Meet oching → **"Record now"** bosing.
2. Chrome oynasida ataylab **noto'g'ri** tanlang: **Chrome Tab** bo'limidan bitta
   tab tanlab **Share** bosing.

✅ **Ko'rishingiz kerak:** *"Choose 'Entire Screen' — picking a tab or window won't
   record the full..."* mazmunidagi ogohlantirish chiqadi.
❌ **Xato bo'lsa:** hech ogohlantirishsiz to'liq yozib ketaversa.

Keyin **Entire Screen** tanlab davom eting va **"Stop"** bosing (bu yozuv kerak emas).

---

## 4-qadam — Pauza rostini gapiradimi (2 daqiqa, ixtiyoriy)

1. Yozuvni boshlang (1-qadamdagidek, Entire Screen).
2. 20 soniya gapiring → **"Pause"** bosing.
3. Pauza paytida **balandroq sanang: "bir, ikki, uch..."** — 15 soniya.
4. **"Resume"** bosing → yana 20 soniya gapiring → **"Stop"**.

✅ **Ko'rishingiz kerak:** pauza paytida taymer **to'xtab turadi**. Tayyor yozuvda
"bir, ikki, uch" sanog'i **eshitilmaydi**.
❌ **Xato bo'lsa:** taymer pauzada ham yursa · yoki sanoq yozuvda eshitilsa.

---

## 5-qadam — Internet uzilsa yozuv yo'qoladimi (3 daqiqa, ixtiyoriy)

1. Yozuvni boshlang → 1 daqiqa gapiring.
2. **Wi-Fi'ni o'chiring**.
3. Yana 30 soniya gapiring → **"Stop"**.
4. Chrome'ni **butunlay yoping** → Wi-Fi'ni yoqing → Chrome'ni qayta oching → 2 daqiqa kuting.
5. Dashboard'ni oching.

✅ **Ko'rishingiz kerak:** yozuv o'zi paydo bo'ladi va **oxirigacha** o'ynaydi —
internet uzilgandan keyingi 30 soniya ham ichida.
❌ **Xato bo'lsa:** yozuv kelmasa · uzilgan joyda kesilsa · "yo'qoldi" chiqsa.

---

## Yakunda menga nima ayting

Har bir qadam uchun bitta so'z yetadi:

```
0-qadam: ha / yo'q
1-qadam: ha / yo'q
2-qadam: ha / yo'q   ← ENG MUHIMI (ikkala yozuvda ham suhbatdosh ovozi)
3-qadam: ha / yo'q / qilmadim
4-qadam: ha / yo'q / qilmadim
5-qadam: ha / yo'q / qilmadim
```

"Yo'q" bo'lsa — **ekranda nima yozilganini** qo'shing.

**Deploy qarori:** 1-qadam va 2-qadam o'tmaguncha "production ready" demaymiz. Qolgan
qadamlar yiqilsa — muhim, lekin to'xtatuvchi emas; men tuzataman.
