using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Win32;
public static class FengshaTemporaryRoot {
  [DllImport("crypt32.dll", EntryPoint="CertOpenStore", ExactSpelling=true, SetLastError=true)]
  static extern IntPtr CertOpenRegistryStore(IntPtr provider, uint encoding, IntPtr crypt, uint flags, Microsoft.Win32.SafeHandles.SafeRegistryHandle key);
  [DllImport("crypt32.dll", SetLastError=true)]
  static extern IntPtr CertFindCertificateInStore(IntPtr store, uint encoding, uint flags, uint find, IntPtr parameter, IntPtr previous);
  [DllImport("crypt32.dll", SetLastError=true)]
  static extern bool CertDeleteCertificateFromStore(IntPtr context);
  [DllImport("crypt32.dll")] static extern bool CertFreeCertificateContext(IntPtr context);
  [DllImport("crypt32.dll")] static extern bool CertCloseStore(IntPtr store, uint flags);
  [DllImport("crypt32.dll", SetLastError=true)] static extern bool CertControlStore(IntPtr store, uint flags, uint control, IntPtr parameter);
  public static void Refresh(IntPtr store) {
    if (!CertControlStore(store, 0, 1, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public static void Update(bool add, byte[] bytes) {
    using (var certificate = new X509Certificate2(bytes)) {
      if (!certificate.GetNameInfo(X509NameType.SimpleName, false).StartsWith("Fengsha-WeChat-", StringComparison.Ordinal))
        throw new InvalidOperationException("Unexpected certificate identity");
      if (add) {
        // Use the protected logical store. A raw registry insertion is discarded
        // by Windows when the root has not received its trust confirmation.
        using (var logical = new X509Store(StoreName.Root, StoreLocation.CurrentUser)) {
          logical.Open(OpenFlags.ReadWrite);
          logical.Add(certificate);
        }
        return;
      }
      // Open only this user's existing physical root registry through CryptoAPI.
      // No LocalMachine store or global protected-root policy is changed.
      using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\SystemCertificates\Root", true)) {
      if (key == null) throw new InvalidOperationException("User certificate store unavailable");
      IntPtr store = CertOpenRegistryStore(new IntPtr(4), 0, IntPtr.Zero, 0, key.Handle);
      if (store == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      IntPtr context = IntPtr.Zero;
      try {
          context = CertFindCertificateInStore(store, 1, 0, 13u << 16, certificate.Handle, IntPtr.Zero);
          if (context == IntPtr.Zero) return;
          using (var matched = new X509Certificate2(context)) {
            if (matched.Thumbprint != certificate.Thumbprint || Convert.ToBase64String(matched.RawData) != Convert.ToBase64String(bytes))
              throw new InvalidOperationException("Certificate mismatch");
          }
          // The delete call consumes the context even on failure.
          IntPtr removed = context; context = IntPtr.Zero;
          if (!CertDeleteCertificateFromStore(removed)) throw new Win32Exception(Marshal.GetLastWin32Error());
      } finally {
        if (context != IntPtr.Zero) CertFreeCertificateContext(context);
        CertCloseStore(store, 0);
      }
      }
    }
  }
}
public static class FengshaProxyNotice {
  [System.Runtime.InteropServices.DllImport("wininet.dll", SetLastError=true)]
  public static extern bool InternetSetOption(System.IntPtr h, int option, System.IntPtr buffer, int length);
}
