// Windowless Native Messaging host. No Python, shell, child process or UI framework.
using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;

[assembly: AssemblyTitle("BrowserAgent Native Messaging Host")]
[assembly: AssemblyDescription("Windowless DPAPI credential host")]
[assembly: AssemblyVersion("0.8.1.0")]
[assembly: AssemblyFileVersion("0.8.1.1")]

[DataContract]
internal sealed class HostRequest
{
    [DataMember(Name = "cmd")]
    public string Command { get; set; }
}

internal static class BridgeHost
{
    private const string Origin = "chrome-extension://hckjfiinhjpgdenpmcgeafkajechobmf/";
    private const int MaxRequest = 4096;
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("BrowserAgent.NativeBridge.v1");

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int number);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetFileType(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadFile(IntPtr handle, byte[] buffer, uint length,
                                        out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteFile(IntPtr handle, byte[] buffer, uint length,
                                         out uint written, IntPtr overlapped);

    private static byte[] ReadExact(IntPtr input, int length)
    {
        byte[] result = new byte[length];
        int offset = 0;
        while (offset < length)
        {
            byte[] part = new byte[length - offset];
            uint count;
            if (!ReadFile(input, part, (uint)part.Length, out count, IntPtr.Zero) || count == 0)
                throw new IOException("Native input closed");
            Buffer.BlockCopy(part, 0, result, offset, (int)count);
            offset += (int)count;
        }
        return result;
    }

    private static void WriteMessage(IntPtr output, string message)
    {
        byte[] body = Encoding.UTF8.GetBytes(message);
        byte[] frame = new byte[body.Length + 4];
        Buffer.BlockCopy(BitConverter.GetBytes((uint)body.Length), 0, frame, 0, 4);
        Buffer.BlockCopy(body, 0, frame, 4, body.Length);
        int offset = 0;
        while (offset < frame.Length)
        {
            byte[] part = new byte[frame.Length - offset];
            Buffer.BlockCopy(frame, offset, part, 0, part.Length);
            uint count;
            if (!WriteFile(output, part, (uint)part.Length, out count, IntPtr.Zero) || count == 0)
                throw new IOException("Native output closed");
            offset += (int)count;
        }
        Array.Clear(body, 0, body.Length);
        Array.Clear(frame, 0, frame.Length);
    }

    private static string Credentials(IntPtr input)
    {
        uint length = BitConverter.ToUInt32(ReadExact(input, 4), 0);
        if (length == 0 || length > MaxRequest)
            throw new InvalidDataException("Invalid native message size");
        HostRequest request;
        using (MemoryStream stream = new MemoryStream(ReadExact(input, (int)length)))
            request = (HostRequest)new DataContractJsonSerializer(typeof(HostRequest)).ReadObject(stream);
        if (request == null || request.Command != "get_bridge_credentials")
            throw new InvalidDataException("Invalid command");

        string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                                   "BrowserAgent", "NativeBridge", "credential.dpapi");
        byte[] encrypted;
        using (FileStream file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (file.Length <= 0 || file.Length > 8192)
                throw new InvalidDataException("Invalid credential size");
            encrypted = new byte[(int)file.Length];
            int offset = 0;
            while (offset < encrypted.Length)
            {
                int count = file.Read(encrypted, offset, encrypted.Length - offset);
                if (count == 0) throw new EndOfStreamException();
                offset += count;
            }
        }
        byte[] secret = ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.CurrentUser);
        try
        {
            if (secret.Length != 32) throw new InvalidDataException("Invalid credential");
            StringBuilder hex = new StringBuilder(64);
            foreach (byte value in secret) hex.Append(value.ToString("x2"));
            return "{\"protocol\":1,\"key\":\"" + hex.ToString() + "\"}";
        }
        finally { Array.Clear(secret, 0, secret.Length); }
    }

    private static int Main(string[] args)
    {
        // Reject accidental double-clicks before opening pipes. Never show a dialog.
        if (args.Length == 0 || args[0] != Origin) return 1;
        try
        {
            IntPtr input = GetStdHandle(-10), output = GetStdHandle(-11);
            if (GetFileType(input) != 3 || GetFileType(output) != 3) return 1;
            string response;
            try { response = Credentials(input); }
            catch (Exception)
            {
                // No exception details, paths or credential data leave the host.
                response = "{\"error\":\"Bridge unavailable; start the desktop application\"}";
            }
            WriteMessage(output, response);
            return 0;
        }
        catch (Exception) { return 1; }
    }
}
