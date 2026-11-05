# The native pieces Windows PowerShell lacks, as one C# block compiled on first use with the
# compiler every .NET Framework install carries (Add-Type). Nothing is installed:
#   - Sqlite: the Claude app's cookie database, through winsqlite3.dll that Windows ships
#   - AesGcm: AES-256-GCM, the Windows app's cookie encryption and the backup file's encryption,
#     through Windows' own CNG (bcrypt.dll); streamed, so a backup never sits in memory
#   - Scrypt: the backup file's key derivation (RFC 7914), with its own PBKDF2-HMAC-SHA256
# The compiled DLL is cached under %LOCALAPPDATA%\claude-switcher, named by the source's hash.
# C# 5 syntax only: that is what the .NET Framework compiler speaks.

$script:NativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace ClaudeSwitcher
{
    public sealed class Sqlite : IDisposable
    {
        const string Lib = "winsqlite3.dll";
        const int OK = 0, ROW = 100, DONE = 101;
        const int OpenReadOnly = 1, OpenReadWrite = 2, OpenCreate = 4;
        static readonly IntPtr Transient = new IntPtr(-1);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_open_v2([MarshalAs(UnmanagedType.LPUTF8Str)] string filename, out IntPtr db, int flags, IntPtr vfs);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_close_v2(IntPtr db);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_busy_timeout(IntPtr db, int ms);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_exec(IntPtr db, [MarshalAs(UnmanagedType.LPUTF8Str)] string sql, IntPtr callback, IntPtr arg, out IntPtr errmsg);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_prepare16_v2(IntPtr db, [MarshalAs(UnmanagedType.LPWStr)] string sql, int nByte, out IntPtr stmt, IntPtr tail);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_step(IntPtr stmt);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_finalize(IntPtr stmt);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_column_count(IntPtr stmt);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern IntPtr sqlite3_column_name16(IntPtr stmt, int i);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_column_type(IntPtr stmt, int i);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern long sqlite3_column_int64(IntPtr stmt, int i);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern double sqlite3_column_double(IntPtr stmt, int i);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern IntPtr sqlite3_column_text16(IntPtr stmt, int i);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern IntPtr sqlite3_column_blob(IntPtr stmt, int i);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_column_bytes(IntPtr stmt, int i);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_bind_blob(IntPtr stmt, int i, byte[] value, int n, IntPtr destructor);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_bind_int64(IntPtr stmt, int i, long value);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_bind_double(IntPtr stmt, int i, double value);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_bind_text16(IntPtr stmt, int i, [MarshalAs(UnmanagedType.LPWStr)] string value, int n, IntPtr destructor);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_bind_null(IntPtr stmt, int i);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern IntPtr sqlite3_errmsg16(IntPtr db);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] static extern IntPtr sqlite3_libversion();

        IntPtr db;

        public static string Version() { return Marshal.PtrToStringAnsi(sqlite3_libversion()); }

        public Sqlite(string path, bool readOnly)
        {
            int flags = readOnly ? OpenReadOnly : (OpenReadWrite | OpenCreate);
            int rc = sqlite3_open_v2(path, out db, flags, IntPtr.Zero);
            if (rc != OK)
            {
                string message = db != IntPtr.Zero ? Error() : "cannot open the database";
                if (db != IntPtr.Zero) sqlite3_close_v2(db);
                db = IntPtr.Zero;
                throw new InvalidOperationException("sqlite: " + message);
            }
            sqlite3_busy_timeout(db, 5000);
        }

        string Error() { return Marshal.PtrToStringUni(sqlite3_errmsg16(db)); }

        public void Exec(string sql)
        {
            IntPtr err;
            int rc = sqlite3_exec(db, sql, IntPtr.Zero, IntPtr.Zero, out err);
            if (rc != OK) throw new InvalidOperationException("sqlite: " + Error());
        }

        public List<Dictionary<string, object>> Query(string sql, object[] args)
        {
            IntPtr stmt;
            int rc = sqlite3_prepare16_v2(db, sql, -1, out stmt, IntPtr.Zero);
            if (rc != OK) throw new InvalidOperationException("sqlite: " + Error());
            var rows = new List<Dictionary<string, object>>();
            try
            {
                if (args != null) for (int i = 0; i < args.Length; i++) Bind(stmt, i + 1, args[i]);
                int n = sqlite3_column_count(stmt);
                var names = new string[n];
                for (int i = 0; i < n; i++) names[i] = Marshal.PtrToStringUni(sqlite3_column_name16(stmt, i));
                while (true)
                {
                    rc = sqlite3_step(stmt);
                    if (rc == DONE) break;
                    if (rc != ROW) throw new InvalidOperationException("sqlite: " + Error());
                    var row = new Dictionary<string, object>();
                    for (int i = 0; i < n; i++) row[names[i]] = Column(stmt, i);
                    rows.Add(row);
                }
            }
            finally { sqlite3_finalize(stmt); }
            return rows;
        }

        void Bind(IntPtr stmt, int i, object value)
        {
            int rc;
            if (value == null) rc = sqlite3_bind_null(stmt, i);
            else if (value is byte[]) { var b = (byte[])value; rc = sqlite3_bind_blob(stmt, i, b, b.Length, Transient); }
            else if (value is string) rc = sqlite3_bind_text16(stmt, i, (string)value, -1, Transient);
            else if (value is double || value is float || value is decimal) rc = sqlite3_bind_double(stmt, i, Convert.ToDouble(value));
            else rc = sqlite3_bind_int64(stmt, i, Convert.ToInt64(value));
            if (rc != OK) throw new InvalidOperationException("sqlite: " + Error());
        }

        object Column(IntPtr stmt, int i)
        {
            switch (sqlite3_column_type(stmt, i))
            {
                case 1: return sqlite3_column_int64(stmt, i);
                case 2: return sqlite3_column_double(stmt, i);
                case 3: return Marshal.PtrToStringUni(sqlite3_column_text16(stmt, i));
                case 4:
                {
                    int n = sqlite3_column_bytes(stmt, i);
                    var b = new byte[n];
                    if (n > 0) Marshal.Copy(sqlite3_column_blob(stmt, i), b, 0, n);
                    return b;
                }
                default: return null;
            }
        }

        public void Dispose()
        {
            if (db != IntPtr.Zero) { sqlite3_close_v2(db); db = IntPtr.Zero; }
        }
    }

    // AES-GCM through CNG, in chained calls so that a stream of any size can be sealed or opened.
    // Feed Update with data in any sizes; Final returns the rest and, when encrypting, leaves the
    // tag in Tag; when decrypting it takes the expected tag and fails if the data was changed.
    public sealed class AesGcm : IDisposable
    {
        [StructLayout(LayoutKind.Sequential)]
        struct AuthInfo
        {
            public int cbSize; public int dwInfoVersion; public IntPtr pbNonce; public int cbNonce;
            public IntPtr pbAuthData; public int cbAuthData; public IntPtr pbTag; public int cbTag;
            public IntPtr pbMacContext; public int cbMacContext; public int cbAAD; public long cbData; public int dwFlags;
        }
        [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)] static extern int BCryptOpenAlgorithmProvider(out IntPtr hAlg, string algId, string implementation, int flags);
        [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)] static extern int BCryptSetProperty(IntPtr hObject, string property, byte[] input, int cbInput, int flags);
        [DllImport("bcrypt.dll")] static extern int BCryptGenerateSymmetricKey(IntPtr hAlg, out IntPtr hKey, IntPtr keyObject, int cbKeyObject, byte[] secret, int cbSecret, int flags);
        [DllImport("bcrypt.dll")] static extern int BCryptEncrypt(IntPtr hKey, byte[] input, int cbInput, ref AuthInfo info, byte[] iv, int cbIV, byte[] output, int cbOutput, out int cbResult, int flags);
        [DllImport("bcrypt.dll")] static extern int BCryptDecrypt(IntPtr hKey, byte[] input, int cbInput, ref AuthInfo info, byte[] iv, int cbIV, byte[] output, int cbOutput, out int cbResult, int flags);
        [DllImport("bcrypt.dll")] static extern int BCryptDestroyKey(IntPtr hKey);
        [DllImport("bcrypt.dll")] static extern int BCryptCloseAlgorithmProvider(IntPtr hAlg, int flags);
        const int ChainCalls = 1;
        const int TagSize = 16;

        IntPtr hAlg, hKey;
        readonly bool encrypt;
        AuthInfo info;
        GCHandle hNonce, hTag, hMac;
        readonly byte[] nonce, tag, mac;
        readonly byte[] iv = new byte[16]; // in chained calls CNG keeps the running counter here
        byte[] pending = new byte[0];

        public AesGcm(byte[] key, byte[] nonce, bool encrypt)
        {
            if (key.Length != 32) throw new ArgumentException("the key must be 32 bytes");
            this.encrypt = encrypt;
            this.nonce = (byte[])nonce.Clone();
            tag = new byte[TagSize];
            mac = new byte[TagSize];
            Check(BCryptOpenAlgorithmProvider(out hAlg, "AES", null, 0), "open AES");
            byte[] mode = Encoding.Unicode.GetBytes("ChainingModeGCM\0");
            Check(BCryptSetProperty(hAlg, "ChainingMode", mode, mode.Length, 0), "set GCM");
            Check(BCryptGenerateSymmetricKey(hAlg, out hKey, IntPtr.Zero, 0, key, key.Length, 0), "make the key");
            hNonce = GCHandle.Alloc(this.nonce, GCHandleType.Pinned);
            hTag = GCHandle.Alloc(tag, GCHandleType.Pinned);
            hMac = GCHandle.Alloc(mac, GCHandleType.Pinned);
            info = new AuthInfo();
            info.cbSize = Marshal.SizeOf(typeof(AuthInfo));
            info.dwInfoVersion = 1;
            info.pbNonce = hNonce.AddrOfPinnedObject(); info.cbNonce = this.nonce.Length;
            info.pbTag = hTag.AddrOfPinnedObject(); info.cbTag = TagSize;
            info.pbMacContext = hMac.AddrOfPinnedObject(); info.cbMacContext = TagSize;
            info.dwFlags = ChainCalls;
        }

        static void Check(int status, string what)
        {
            if (status != 0) throw new CryptographicException("AES-GCM: could not " + what + " (0x" + status.ToString("x8") + ")");
        }

        public byte[] Update(byte[] data)
        {
            byte[] all = new byte[pending.Length + data.Length];
            Buffer.BlockCopy(pending, 0, all, 0, pending.Length);
            Buffer.BlockCopy(data, 0, all, pending.Length, data.Length);
            int whole = all.Length - (all.Length % 16);
            pending = new byte[all.Length - whole];
            Buffer.BlockCopy(all, whole, pending, 0, pending.Length);
            if (whole == 0) return new byte[0];
            byte[] input = new byte[whole];
            Buffer.BlockCopy(all, 0, input, 0, whole);
            return Run(input);
        }

        public byte[] Final(byte[] expectedTag)
        {
            info.dwFlags &= ~ChainCalls; // keep the "in progress" bit CNG set: the tag covers it all
            if (!encrypt)
            {
                if (expectedTag == null || expectedTag.Length != TagSize) throw new ArgumentException("the tag must be 16 bytes");
                Buffer.BlockCopy(expectedTag, 0, tag, 0, TagSize);
            }
            byte[] output = Run(pending);
            pending = new byte[0];
            return output;
        }

        public byte[] Tag { get { return (byte[])tag.Clone(); } }

        byte[] Run(byte[] input)
        {
            // Real buffers even for no data: with a null output CNG only reports a size and does
            // not finish the tag.
            byte[] inBuf = input.Length == 0 ? new byte[1] : input;
            byte[] output = new byte[Math.Max(1, input.Length)];
            int cb;
            int rc = encrypt
                ? BCryptEncrypt(hKey, inBuf, input.Length, ref info, iv, iv.Length, output, input.Length, out cb, 0)
                : BCryptDecrypt(hKey, inBuf, input.Length, ref info, iv, iv.Length, output, input.Length, out cb, 0);
            if (rc != 0) throw new CryptographicException(encrypt ? "AES-GCM encryption failed (0x" + rc.ToString("x8") + ")" : "wrong key or passphrase, or the data is damaged");
            if (input.Length == 0) return new byte[0];
            return output;
        }

        // One-shot helpers: Seal returns ciphertext + tag; Open takes the same and gives the plaintext back.
        public static byte[] Seal(byte[] key, byte[] nonce, byte[] plain)
        {
            using (var g = new AesGcm(key, nonce, true))
            {
                byte[] a = g.Update(plain);
                byte[] b = g.Final(null);
                byte[] t = g.Tag;
                byte[] outp = new byte[a.Length + b.Length + t.Length];
                Buffer.BlockCopy(a, 0, outp, 0, a.Length);
                Buffer.BlockCopy(b, 0, outp, a.Length, b.Length);
                Buffer.BlockCopy(t, 0, outp, a.Length + b.Length, t.Length);
                return outp;
            }
        }

        public static byte[] Open(byte[] key, byte[] nonce, byte[] cipherAndTag)
        {
            if (cipherAndTag.Length < TagSize) throw new CryptographicException("too short to hold a tag");
            byte[] cipher = new byte[cipherAndTag.Length - TagSize];
            byte[] t = new byte[TagSize];
            Buffer.BlockCopy(cipherAndTag, 0, cipher, 0, cipher.Length);
            Buffer.BlockCopy(cipherAndTag, cipher.Length, t, 0, TagSize);
            using (var g = new AesGcm(key, nonce, false))
            {
                byte[] a = g.Update(cipher);
                byte[] b = g.Final(t);
                byte[] outp = new byte[a.Length + b.Length];
                Buffer.BlockCopy(a, 0, outp, 0, a.Length);
                Buffer.BlockCopy(b, 0, outp, a.Length, b.Length);
                return outp;
            }
        }

        public void Dispose()
        {
            if (hKey != IntPtr.Zero) { BCryptDestroyKey(hKey); hKey = IntPtr.Zero; }
            if (hAlg != IntPtr.Zero) { BCryptCloseAlgorithmProvider(hAlg, 0); hAlg = IntPtr.Zero; }
            if (hNonce.IsAllocated) hNonce.Free();
            if (hTag.IsAllocated) hTag.Free();
            if (hMac.IsAllocated) hMac.Free();
        }
    }

    // scrypt (RFC 7914) with its own PBKDF2-HMAC-SHA256, since the framework's wants an 8-byte salt.
    public static class Scrypt
    {
        public static byte[] Derive(byte[] password, byte[] salt, int n, int r, int p, int dkLen)
        {
            if (n < 2 || (n & (n - 1)) != 0) throw new ArgumentException("N must be a power of two");
            byte[] b = Pbkdf2(password, salt, 1, p * 128 * r);
            uint[] v = new uint[32 * r * n];
            uint[] xy = new uint[64 * r];
            for (int i = 0; i < p; i++) RoMix(b, i * 128 * r, r, n, v, xy);
            return Pbkdf2(password, b, 1, dkLen);
        }

        public static byte[] Pbkdf2(byte[] password, byte[] salt, int iterations, int dkLen)
        {
            using (var hmac = new HMACSHA256(password))
            {
                int hLen = 32;
                int blocks = (dkLen + hLen - 1) / hLen;
                byte[] output = new byte[blocks * hLen];
                byte[] block = new byte[salt.Length + 4];
                Buffer.BlockCopy(salt, 0, block, 0, salt.Length);
                for (int i = 1; i <= blocks; i++)
                {
                    block[salt.Length] = (byte)(i >> 24); block[salt.Length + 1] = (byte)(i >> 16);
                    block[salt.Length + 2] = (byte)(i >> 8); block[salt.Length + 3] = (byte)i;
                    byte[] u = hmac.ComputeHash(block);
                    byte[] t = (byte[])u.Clone();
                    for (int j = 1; j < iterations; j++)
                    {
                        u = hmac.ComputeHash(u);
                        for (int k = 0; k < hLen; k++) t[k] ^= u[k];
                    }
                    Buffer.BlockCopy(t, 0, output, (i - 1) * hLen, hLen);
                }
                byte[] result = new byte[dkLen];
                Buffer.BlockCopy(output, 0, result, 0, dkLen);
                return result;
            }
        }

        static void RoMix(byte[] b, int offset, int r, int n, uint[] v, uint[] xy)
        {
            int words = 32 * r;
            uint[] x = new uint[words];
            for (int i = 0; i < words; i++) x[i] = BitConverter.ToUInt32(b, offset + i * 4);
            for (int i = 0; i < n; i++)
            {
                Array.Copy(x, 0, v, i * words, words);
                BlockMix(x, r, xy);
            }
            for (int i = 0; i < n; i++)
            {
                int j = (int)(x[(2 * r - 1) * 16] & (uint)(n - 1));
                for (int k = 0; k < words; k++) x[k] ^= v[j * words + k];
                BlockMix(x, r, xy);
            }
            for (int i = 0; i < words; i++)
            {
                byte[] w = BitConverter.GetBytes(x[i]);
                Buffer.BlockCopy(w, 0, b, offset + i * 4, 4);
            }
        }

        static void BlockMix(uint[] b, int r, uint[] y)
        {
            uint[] x = new uint[16];
            Array.Copy(b, (2 * r - 1) * 16, x, 0, 16);
            for (int i = 0; i < 2 * r; i++)
            {
                for (int k = 0; k < 16; k++) x[k] ^= b[i * 16 + k];
                Salsa8(x);
                Array.Copy(x, 0, y, i * 16, 16);
            }
            for (int i = 0; i < r; i++) Array.Copy(y, (2 * i) * 16, b, i * 16, 16);
            for (int i = 0; i < r; i++) Array.Copy(y, (2 * i + 1) * 16, b, (r + i) * 16, 16);
        }

        static uint R(uint a, int b) { return (a << b) | (a >> (32 - b)); }

        static void Salsa8(uint[] b)
        {
            uint[] x = (uint[])b.Clone();
            for (int i = 0; i < 8; i += 2)
            {
                x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
                x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
                x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
                x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
                x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
                x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
                x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
                x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
            }
            for (int i = 0; i < 16; i++) b[i] += x[i];
        }
    }
}
'@

function Import-Native {
    if ('ClaudeSwitcher.Sqlite' -as [type]) { return }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($script:NativeSource))).Replace('-', '').Substring(0, 16).ToLower()
    $base = [Environment]::GetEnvironmentVariable('LOCALAPPDATA')
    if (-not $base) { $base = [System.IO.Path]::GetTempPath() }
    $cacheDir = Join-Path $base 'claude-switcher'
    $dll = Join-Path $cacheDir "native-$hash.dll"
    if (Test-Path $dll) {
        try { Add-Type -Path $dll; return } catch { Remove-Item $dll -Force -ErrorAction SilentlyContinue }
    }
    try {
        if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
        Add-Type -TypeDefinition $script:NativeSource -OutputAssembly $dll -OutputType Library
        Add-Type -Path $dll
    } catch {
        Add-Type -TypeDefinition $script:NativeSource
    }
}
