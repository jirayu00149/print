# Wi-Fi Printer Bridge

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/jirayu00149/print)

หน้าเว็บเล็ก ๆ สำหรับส่งงานพิมพ์ผ่าน Wi-Fi ไปที่ `192.168.10.1:9100` หรือ IP/พอร์ตอื่นที่กำหนดได้

## เริ่มใช้งาน

```powershell
npm start
```

จากนั้นเปิด:

```text
http://localhost:8080
```

## การเชื่อมต่อ

- ค่าเริ่มต้นคือ `192.168.10.1` พอร์ต `9100`
- ใช้ได้กับเครื่องพิมพ์ที่รับ RAW TCP หรือ ESC/POS ผ่านพอร์ตเครือข่าย
- ถ้าเชื่อมไม่ได้ ให้ตรวจว่าเครื่องคอมอยู่ Wi-Fi วงเดียวกับเครื่องพิมพ์ และลอง ping `192.168.10.1`

## พิมพ์ไฟล์

รองรับไฟล์ข้อความ เช่น `.txt`, `.csv`, `.json`, `.log`, `.html`, `.xml`, `.md` และไฟล์คำสั่งเครื่องพิมพ์แบบ raw เช่น `.prn`, `.bin`, `.raw`, `.escpos`

ไฟล์ PDF และรูปภาพยังไม่สามารถส่งเข้า RAW TCP/ESC-POS ได้โดยตรง ต้องแปลงเป็นคำสั่งของเครื่องพิมพ์หรือใช้ไดรเวอร์ของระบบปฏิบัติการก่อน

## หมายเหตุเรื่องภาษาไทย

โหมด ESC/POS ส่งข้อความเป็น UTF-8 แบบตรง ๆ เครื่องพิมพ์บางรุ่นอาจต้องตั้ง code page หรือใช้ไดรเวอร์เฉพาะจึงจะพิมพ์ภาษาไทยได้ถูกต้อง

## ใช้หน้าเว็บบน Cloudflare

Cloudflare โฮสต์หน้าเว็บได้ แต่ Cloudflare ต่อเข้า IP ส่วนตัวอย่าง `192.168.10.1` โดยตรงไม่ได้ ดังนั้นต้องเปิด local bridge บนเครื่องที่อยู่ Wi-Fi เดียวกับเครื่องพิมพ์ไว้ด้วย

```powershell
npm start
```

ถ้าเปิดหน้าเว็บจาก Cloudflare บนเครื่องเดียวกัน ระบบจะเรียก API ที่ `http://localhost:8080` อัตโนมัติ

ถ้า local bridge อยู่เครื่องอื่น หน้า Cloudflare อาจถูกเบราว์เซอร์บล็อกเวลาเรียก `http://IP-เครื่องอื่น:8080` จากหน้า HTTPS ให้เปิดหน้า local bridge โดยตรงแทน:

```text
http://IP-เครื่องที่รัน-bridge:8080
```

หรือทำให้ local bridge มี HTTPS/Cloudflare Tunnel ก่อน แล้วค่อยใช้ query string:

```text
https://your-cloudflare-url/?api=https://URL-bridge
```

## Deploy บน Render

โปรเจกต์มี `render.yaml` สำหรับสร้าง Render Web Service แล้ว

- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/api/health`

ข้อจำกัดเหมือน Cloudflare: Render ต่อเข้า `192.168.10.1` ในวง Wi-Fi ส่วนตัวไม่ได้โดยตรง ถ้าต้องสั่งพิมพ์จริง ให้รัน local bridge บนเครื่องที่อยู่ Wi-Fi เดียวกับเครื่องพิมพ์ หรือทำ tunnel/VPN ให้ Render เข้าถึงเครื่องพิมพ์ได้

ถ้าเปิดหน้าเว็บจาก Render แต่ต้องการให้ปุ่มพิมพ์ยิงกลับมาที่ local bridge บนเครื่องนี้ ให้เปิด URL แบบนี้:

```text
https://your-render-url.onrender.com/?api=http://localhost:8080
```
