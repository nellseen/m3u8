import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';
import { config, isConfigured, saveApiCredentials, saveSessionString } from '../src/config.ts';

async function login() {
  console.log('\n======================================================');
  console.log('   Telegram Userbot - Interactive Account Login');
  console.log('======================================================\n');

  let apiId = config.apiId;
  let apiHash = config.apiHash;

  if (!isConfigured()) {
    console.log('💡 TELEGRAM_API_ID & TELEGRAM_API_HASH belum diisi di environment.');
    console.log('Dapatkan secara gratis dari https://my.telegram.org -> API development tools.\n');
    
    const apiIdStr = await input.text('Masukkan TELEGRAM_API_ID Anda: ');
    apiId = parseInt(apiIdStr.trim(), 10);
    const enteredHash = await input.text('Masukkan TELEGRAM_API_HASH Anda: ');
    apiHash = enteredHash.trim();

    if (!apiId || !apiHash) {
      console.error('\n❌ Error: TELEGRAM_API_ID dan TELEGRAM_API_HASH wajib diisi!');
      process.exit(1);
    }

    // Auto-save credentials into .env so the user never touches .env manually
    saveApiCredentials(apiId, apiHash);
    console.log('\n✅ [OK] Kredensial API berhasil disimpan otomatis ke .env!');
  } else {
    console.log(`✅ [OK] Kredensial API terdeteksi (API ID: ${apiId}).`);
  }

  console.log('\nMenghubungkan ke server Telegram...');
  const stringSession = new StringSession(config.session || '');
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () =>
      await input.text('Masukkan nomor HP Telegram Anda (format internasional, cth: +62812...): '),
    password: async () =>
      await input.password('Masukkan kata sandi 2FA Anda (kosongkan jika tidak aktif): '),
    phoneCode: async () =>
      await input.text('Masukkan kode verifikasi yang dikirim ke aplikasi Telegram Anda: '),
    onError: (err) => console.error('Authentication Error:', err),
  });

  console.log('\n🎉 Berhasil login ke akun Telegram!');
  const sessionString = client.session.save() as unknown as string;

  // Auto-save session string to session.txt AND .env
  saveSessionString(sessionString);
  console.log(`✅ Sesi akun tersimpan otomatis ke: ${config.sessionFilePath} dan .env`);

  const me = await client.getMe();
  console.log(`Akun aktif: ${(me as any).firstName} (@${(me as any).username || (me as any).id})`);
  console.log('\n🚀 Sekarang Anda dapat langsung menjalankan bot dengan: pnpm start\n');

  await client.disconnect();
  process.exit(0);
}

login().catch(err => {
  console.error('\n❌ Proses login gagal:', err.message || err);
  process.exit(1);
});
