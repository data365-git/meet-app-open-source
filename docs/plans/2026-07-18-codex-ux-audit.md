# Ustoz Meeting Recording + UX/UI Deep Audit

Date: 2026-07-18  
Audited stable target: commit `94af12d`  
Live target: `https://data365.duckdns.org` (older deployment)  
Verdict: **NOT PRODUCTION-READY**

## Qisqa xulosa

Yangi Critical xato isbotlanmadi. Lekin ikkita High muammo bor va ular appning eng asosiy va'dasini buzadi:

1. `Record Meet tab only` ba'zi holatda masofadagi odamlarning ovozisiz video saqlashi mumkin va foydalanuvchini to'xtatmaydi.
2. `Cancel upload` haqiqiy bekor qilish yoki o'chirish emas: serverdagi multipart qismlar va qayta urinishlar qolishi mumkin.

Shuning uchun hozirgi barqaror nomzodni jamoaga chiqarish mumkin emas.

## Topilmalar

### High — Meet tab-only rejimi ovozsiz “muvaffaqiyatli” video berishi mumkin

Popup `Record Meet tab only` variantini beradi. Audio+video olish ishlamasa, recorder video-only rejimiga jim o'tadi. Yakunda fayl saqlangandek ko'rinadi, lekin masofadagi ovozlar yo'q bo'lishi mumkin.

Kerakli yechim: bu rejimni Meet uchun olib tashlash yoki full-screen yo'lidagi kabi audio yo'q bo'lsa boshlamaslik va yozish paytida audio yo'qolishini kuchli ko'rsatish.

### High — “Cancel upload” foydalanuvchiga noto'g'ri va'da beradi

Uploading holatida Cancel bosilganda UI idle holatga qaytadi. Ammo kod server multipart uploadini abort qilmaydi, retry navbatini tozalamaydi va tayyor obyektni o'chirmaydi.

Natija: maxfiy video o'chirildimi yoki yo'qmi noma'lum; orphan qismlar va yashirin retry qolishi mumkin.

Kerakli yechim: ikki alohida amal:

- `Close — upload backgroundda davom etadi`
- ikki bosqichli `Permanently discard`

Permanent discard local buffer, state, retry/dead-letter, server multipart va tayyor video obyektini birgalikda tozalashi kerak.

### Medium — Pause/Resume holati yolg'on ko'rinishi mumkin

Pause yoki Resume buyrug'i recorderga yetib bormasa ham kod popupdagi persisted holatni o'zgartiradi.

Natija: UI “Paused” deydi, lekin yozish davom etishi mumkin; yoki aksincha.

Kerakli yechim: recorder buyruqni qabul qilganini tasdiqlamaguncha UI holatini o'zgartirmaslik.

### Medium — Asosiy recorder oynasida Pause/Resume yo'q

Popupda Pause/Resume bor. Lekin yozish boshlanganidan keyin ochiq turadigan recorder sahifasida faqat `Stop & upload` bor.

Kerakli yechim: Pause/Resume ni doim ko'rinadigan recorder oynasiga qo'shish va ikkala oynani bir xil holatda ushlash.

### Medium — “Full-screen meeting” va keyingi ekran bir-biriga zid

Popup `Record full-screen meeting` deydi. Keyingi ekran esa `Record Instruction` deydi va screen/window/tab tanlashni taklif qiladi.

Natija: foydalanuvchi noto'g'ri surface tanlab, full-screen guarantee ishlayapti deb o'ylashi mumkin.

Kerakli yechim: meetingga xos matn, pickerda nimani tanlash bo'yicha bitta aniq ko'rsatma va tanlangan surface tekshiruvi.

### Medium — Accessibility yetarli emas

- Mic toggle keyboard fokusidan chiqarilgan.
- Visible focus holatlari topilmadi.
- Timer, warning, upload progress, complete va error screen readerga avtomatik aytilmaydi.
- Confirm modal semantik dialog emas.
- Reduced motion qo'llab-quvvatlanmagan.

### Medium — Hozirgi dirty tree release gate'dan o'tmadi

Extension testlari 48/48, web recording testlari 42/42 va extension build o'tdi. Lekin root typecheck `recover-stale-ai-jobs` route type xatosi bilan yiqildi. Bu tree release candidate emas.

### Low — Til va vizual tizim bo'linib ketgan

Jonli sayt Uzbek, popup English, recorder esa English va Uzbekni bitta flowda aralashtiradi. Recorder primary rangi purple, web esa blue-led.

### Low — Mobile hali isbotlanmagan

Desktop live playback va tablar tekshirildi. 390 px viewport haqiqiy ishga tushmadi, shuning uchun mobile `Unverified`.

## Ijobiy tomonlar

- Jonli desktop playback ishladi: video yurdi va pause bo'ldi.
- Summary, tasks, transcript va text bo'limlari ochildi.
- Desktopda horizontal overflow yo'q.
- Watch sahifasining video-first hierarchy'si tushunarli.
- Recorder idle kartasi toza va primary action aniq.
- Frozen extension testlari 42/42 o'tdi.

## Tekshiruv chegaralari

Extension o'rnatilmadi va Chrome permission berilmadi. Productionga recording yozilmadi. Real Meet remote audio, mute recovery, pause privacy, browser restart, offline finalize, mobile va playback-to-end hali `Unverified`.

## Release uchun tartib

1. Ikki High muammoni tuzatish.
2. Pause/Resume holatini haqiqiy recorder holatiga bog'lash.
3. Bitta clean, frozen release candidate yaratish.
4. Typecheck, production build va focused testlarni qayta o'tkazish.
5. Real Meetda local+remote ovoz, pause, mute, offline stop, Chrome restart va dashboarddagi final framegacha playbackni tekshirish.

Shulardan biri buzilsa, release bloklanadi.
