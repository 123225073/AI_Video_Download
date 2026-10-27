using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Text;
using System.IO;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Win32;

// Bounded UI Automation steps for the selected public WeChat account.
// No chat reads, credentials, network interception or system policy changes.
public static class FengshaWeChatArticles {
  delegate bool EnumWindow(IntPtr window,IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback,IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint processId);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window,int command);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window,uint command);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int count);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr window);
  static volatile string Stage="starting";
  sealed class ProcessMetadata { public uint Id;public uint Parent;public string Path;public DateTime Created; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct ProcessEntry {public uint Size;public uint Usage;public uint Id;public UIntPtr Heap;public uint Module;public uint Threads;public uint Parent;public int Priority;public uint Flags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string Exe;}
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint process);
  [DllImport("kernel32.dll",EntryPoint="Process32FirstW",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool ProcessFirst(IntPtr snapshot,ref ProcessEntry entry);
  [DllImport("kernel32.dll",EntryPoint="Process32NextW",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool ProcessNext(IntPtr snapshot,ref ProcessEntry entry);
  [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,uint process);
  [DllImport("kernel32.dll",EntryPoint="QueryFullProcessImageNameW",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool ProcessPath(IntPtr process,uint flags,StringBuilder path,ref uint count);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetProcessTimes(IntPtr process,out long creation,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] sealed class TrustFile { public uint Size=(uint)Marshal.SizeOf(typeof(TrustFile));[MarshalAs(UnmanagedType.LPWStr)]public string Path;public IntPtr Handle=IntPtr.Zero;public IntPtr Subject=IntPtr.Zero; }
  [StructLayout(LayoutKind.Sequential)] struct TrustData { public uint Size;public IntPtr Policy;public IntPtr SIP;public uint UI;public uint Revocation;public uint Choice;public IntPtr File;public uint StateAction;public IntPtr State;public IntPtr URL;public uint Flags;public uint Context;public IntPtr Signature; }
  [DllImport("wintrust.dll",ExactSpelling=true)] static extern int WinVerifyTrust(IntPtr window,ref Guid action,ref TrustData data);
  static readonly Dictionary<string,bool> SignatureCache=new Dictionary<string,bool>(StringComparer.OrdinalIgnoreCase);
  static readonly List<FileStream> SignatureLocks=new List<FileStream>();
  sealed class Candidate { public IntPtr Window;public uint Process;public AutomationElement Root;public AutomationElement Document;public string Path; }
  sealed class ToolbarResult { public AutomationElement Button;public AutomationElement Container;public int Ancestors;public int Toolbars;public int Buttons;public int OwnerRejected;public bool Limited; }
  static bool WeChatProcess(string name) { return String.Equals(name,"Weixin",StringComparison.OrdinalIgnoreCase)||String.Equals(name,"WeChat",StringComparison.OrdinalIgnoreCase); }
  static bool SamePath(string a,string b) { try{return Path.GetFullPath(a).TrimEnd('\\')==Path.GetFullPath(b).TrimEnd('\\')||String.Equals(Path.GetFullPath(a).TrimEnd('\\'),Path.GetFullPath(b).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase);}catch{return false;} }
  static string PluginPath() { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),@"Tencent\xwechat\xplugin\plugins\RadiumWMPF\WeChatAppEx.exe"); }
  static ProcessMetadata Metadata(uint id) {
    Stage="process-owner";
    // Read only the target PID's parent relation, image path and creation time.
    // Toolhelp is used for the target parent ID only; no command line or UI is
    // requested. QUERY_LIMITED_INFORMATION does not request VM/debug access.
    uint parent=0;var snapshot=CreateToolhelp32Snapshot(2,0);if(snapshot==new IntPtr(-1))return null;
    try{var entry=new ProcessEntry{Size=(uint)Marshal.SizeOf(typeof(ProcessEntry))};if(ProcessFirst(snapshot,ref entry))do{if(entry.Id==id){parent=entry.Parent;break;}}while(ProcessNext(snapshot,ref entry));}finally{CloseHandle(snapshot);}
    if(parent==0)return null;var process=OpenProcess(0x1000,false,id);if(process==IntPtr.Zero)return null;
    try{uint count=32768;var path=new StringBuilder((int)count);long created,exit,kernel,user;if(!ProcessPath(process,0,path,ref count)||!GetProcessTimes(process,out created,out exit,out kernel,out user))return null;return new ProcessMetadata{Id=id,Parent=parent,Path=path.ToString(),Created=DateTime.FromFileTimeUtc(created)};}finally{CloseHandle(process);}
  }
  static bool TencentSigned(string path) {
    bool cached;if(SignatureCache.TryGetValue(path,out cached))return cached;
    Stage="process-signature";bool valid=false;IntPtr memory=IntPtr.Zero;FileStream locked=null;
    try {
      // Keep the verified image read-locked during this short-lived helper, so
      // later ancestry checks cannot reuse a signature after replacement.
      locked=File.Open(path,FileMode.Open,FileAccess.Read,FileShare.Read);
      var action=new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");var file=new TrustFile{Path=path};memory=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TrustFile)));Marshal.StructureToPtr(file,memory,false);
      var data=new TrustData{Size=(uint)Marshal.SizeOf(typeof(TrustData)),UI=2,Choice=1,File=memory,StateAction=1,Flags=0x1010};
      // CACHE_ONLY_URL_RETRIEVAL + REVOCATION_CHECK_NONE: no network fetch,
      // certificate installation or trust-policy changes are performed.
      int verified=WinVerifyTrust(new IntPtr(-1),ref action,ref data);data.StateAction=2;WinVerifyTrust(new IntPtr(-1),ref action,ref data);
      if(verified==0)using(var certificate=new X509Certificate2(X509Certificate.CreateFromSignedFile(path)))valid=certificate.GetNameInfo(X509NameType.SimpleName,false)=="Tencent Technology (Shenzhen) Company Limited";
      if(valid){SignatureLocks.Add(locked);locked=null;}
    }catch{valid=false;}finally{if(locked!=null)locked.Dispose();if(memory!=IntPtr.Zero){Marshal.DestroyStructure(memory,typeof(TrustFile));Marshal.FreeHGlobal(memory);}}
    SignatureCache[path]=valid;return valid;
  }
  static bool RegisteredRoot(ProcessMetadata root) {
    if(root==null)return false;string name=Path.GetFileNameWithoutExtension(root.Path);if(!WeChatProcess(name))return false;
    using(var key=Registry.CurrentUser.OpenSubKey(@"Software\Tencent\"+name)){
      string install=key==null?null:key.GetValue("InstallPath") as string;
      return !String.IsNullOrEmpty(install)&&SamePath(root.Path,Path.Combine(install,name+".exe"))&&TencentSigned(root.Path);
    }
  }
  static bool BrowserChain(ProcessMetadata root,ProcessMetadata document,Func<uint,ProcessMetadata> lookup,Func<string,bool> signed) {
    if(root==null||document==null)return false;if(document.Id==root.Id)return SamePath(document.Path,root.Path);
    var seen=new HashSet<uint>();var current=document;
    for(int depth=0;depth<8;depth++){
      if(current==null||!seen.Add(current.Id)||!SamePath(current.Path,PluginPath())||!signed(current.Path))return false;
      var parent=lookup(current.Parent);if(parent==null||parent.Created>current.Created)return false;
      if(parent.Id==root.Id)return SamePath(parent.Path,root.Path)&&parent.Created==root.Created;
      current=parent;
    }
    return false;
  }
  static bool DocumentOwner(uint rootProcess,int documentProcess) {
    if(documentProcess<=0)return false;
    var root=Metadata(rootProcess);if(!RegisteredRoot(root))return false;
    return BrowserChain(root,Metadata((uint)documentProcess),Metadata,TencentSigned);
  }

  static string AccountName,AccountUsername,AccountBiz;
  static string Normalize(string s){return System.Text.RegularExpressions.Regex.Replace(s??"",@"\s+"," ").Trim();}

  static bool Transient(Exception e){return e is System.Runtime.InteropServices.COMException||e is ElementNotAvailableException||e is InvalidOperationException;}
  static string Value(AutomationElement e){try{object p;if(e.TryGetCurrentPattern(ValuePattern.Pattern,out p))return ((ValuePattern)p).Current.Value;var k=AutomationProperty.LookupById(30093);return k==null?null:e.GetCurrentPropertyValue(k,true) as string;}catch(Exception x){if(Transient(x))return null;throw;}}
  static bool Target(AutomationElement e){try{Uri u;if(e.Current.ControlType!=ControlType.Document||e.Current.Name!=AccountName||!Uri.TryCreate(Value(e),UriKind.Absolute,out u))return false;return u.Scheme=="weixin"&&u.Host=="resourceid"&&u.AbsolutePath=="/SubscriptionProfile/profile.html"&&System.Web.HttpUtility.ParseQueryString(u.Query)["userName"]==AccountUsername;}catch(Exception x){if(Transient(x))return false;throw;}}
  static string PublicArticle(AutomationElement e){try{Uri u;if(!Uri.TryCreate(Value(e),UriKind.Absolute,out u)||u.Scheme!="https"||u.Host!="mp.weixin.qq.com"||!u.IsDefaultPort||!String.IsNullOrEmpty(u.UserInfo))return null;if(u.AbsolutePath.StartsWith("/s/"))return u.GetLeftPart(UriPartial.Path);if(u.AbsolutePath!="/s")return null;var q=System.Web.HttpUtility.ParseQueryString(u.Query);if(q["__biz"]!=AccountBiz||String.IsNullOrEmpty(q["mid"]))return null;return "https://mp.weixin.qq.com/s?__biz="+Uri.EscapeDataString(q["__biz"])+"&mid="+Uri.EscapeDataString(q["mid"])+"&idx="+Uri.EscapeDataString(q["idx"]??"1")+(String.IsNullOrEmpty(q["sn"])?"":"&sn="+Uri.EscapeDataString(q["sn"]))+(String.IsNullOrEmpty(q["chksm"])?"":"&chksm="+Uri.EscapeDataString(q["chksm"]));}catch(Exception x){if(Transient(x))return null;throw;}}

  sealed class Profile {public IntPtr Window;public uint Root;public AutomationElement Document;}
  sealed class Card {public string Title;public string Date;public string Key;public AutomationElement Element;}
  static List<IntPtr> BrowserWindows=new List<IntPtr>();
  static bool RestoreAttempted=false;
  static List<ProcessMetadata> Roots=new List<ProcessMetadata>();
  static void Initialize(){foreach(var p in Process.GetProcessesByName("Weixin"))using(p){var m=Metadata((uint)p.Id);if(RegisteredRoot(m))Roots.Add(m);}}
  static List<Profile> Documents(){var found=new List<Profile>();BrowserWindows.Clear();var permitted=new HashSet<uint>();foreach(var p in Process.GetProcessesByName("WeChatAppEx"))using(p)permitted.Add((uint)p.Id);
    EnumWindows((h,x)=>{uint pid;GetWindowThreadProcessId(h,out pid);if(!IsWindowVisible(h)||!permitted.Contains(pid))return true;var caption=new StringBuilder(20);GetWindowText(h,caption,caption.Capacity);if(caption.ToString()!="微信")return true;var owner=Metadata(pid);if(owner==null||!SamePath(owner.Path,PluginPath()))return true;ProcessMetadata root=null;foreach(var r in Roots)if(BrowserChain(r,owner,Metadata,TencentSigned)){root=r;break;}if(root==null)return true;
      BrowserWindows.Add(h);try{var w=AutomationElement.FromHandle(h);foreach(AutomationElement d in w.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Document))){try{if(DocumentOwner(root.Id,d.Current.ProcessId))found.Add(new Profile{Window=h,Root=root.Id,Document=d});}catch(Exception e){if(!Transient(e))throw;}}}catch(Exception e){if(!Transient(e))throw;}return true;},IntPtr.Zero);return found;
  }
  static Profile Current(){Profile match=null;foreach(var p in Documents())if(Target(p.Document)){if(match!=null)throw new Exception("Multiple target account profiles are open");match=p;}if(match==null&&!RestoreAttempted&&BrowserWindows.Count==1&&IsIconic(BrowserWindows[0])){RestoreAttempted=true;ShowWindow(BrowserWindows[0],9);SetForegroundWindow(BrowserWindows[0]);Thread.Sleep(250);return Current();}return match;}

  static void Invoke(AutomationElement e){object p;if(!e.TryGetCurrentPattern(InvokePattern.Pattern,out p))throw new Exception("Control does not support InvokePattern");((InvokePattern)p).Invoke();}
  static AutomationElement ArticleTabClose(Profile article){
    var closes=new List<AutomationElement>();var window=AutomationElement.FromHandle(article.Window);
    foreach(AutomationElement more in window.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Button))){
      if(more.Current.Name!="更多"||more.Current.IsOffscreen||!more.Current.IsEnabled)continue;
      bool outside=true;for(var e=more;e!=null;e=TreeWalker.ControlViewWalker.GetParent(e))if(e.Current.ControlType==ControlType.Document){outside=false;break;}if(!outside)continue;
      var parent=TreeWalker.ControlViewWalker.GetParent(more);
      foreach(AutomationElement e in parent.FindAll(TreeScope.Children,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Button)))if(e.Current.Name=="关闭"&&!e.Current.IsOffscreen&&e.Current.IsEnabled)closes.Add(e);
    }
    return closes.Count==1?closes[0]:null;
  }
  static List<Card> Cards(Profile p,out List<string> texts){if(!Target(p.Document))throw new Exception("Target account profile changed");texts=new List<string>();var elements=new List<AutomationElement>();foreach(AutomationElement e in p.Document.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Text))){if(elements.Count>2500)throw new Exception("Profile scan exceeded limit");elements.Add(e);texts.Add(Normalize(e.Current.Name));}var found=new List<Card>();var occurrences=new Dictionary<string,int>();string date="";
    for(int n=0;n<elements.Count-1;n++){var name=texts[n];if(System.Text.RegularExpressions.Regex.IsMatch(name,@"^(20\d{2}年)?\d{1,2}月\d{1,2}日$"))date=name;if(name.Length==0||!texts[n+1].StartsWith("阅读")||name.StartsWith("阅读"))continue;var card=TreeWalker.ControlViewWalker.GetParent(elements[n]);object action;if(card==null||!card.TryGetCurrentPattern(InvokePattern.Pattern,out action))continue;var key=date+"|"+name;int count;occurrences.TryGetValue(key,out count);occurrences[key]=count+1;found.Add(new Card{Title=name,Date=date,Key=key+"|"+count,Element=card});}return found;
  }

  static void Emit(object message){Console.WriteLine(new JavaScriptSerializer().Serialize(message));Console.Out.Flush();}
  [MTAThread] public static void Main(string[] args){Console.OutputEncoding=new UTF8Encoding(false);if(args.Length==1&&args[0]=="--version"){Emit(new Dictionary<string,object>{{"ok",true},{"component","wechat-article-helper"},{"version",2},{"threadModel",Thread.CurrentThread.GetApartmentState().ToString()}});return;}var report=new Dictionary<string,object>{{"ok",false}};
    try{
      if(args.Length!=2||Array.IndexOf(new[]{"inspect","open-card","read-article","return-article","author-profile","scroll"},args[0])<0)throw new Exception("Invalid action");
      var request=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(Convert.FromBase64String(args[1])));
      AccountName=Convert.ToString(request["name"]);AccountUsername=Convert.ToString(request["username"]);AccountBiz=Convert.ToString(request["biz"]);
      int limit=Convert.ToInt32(request["limit"]);if(AccountName.Length<1||AccountName.Length>100||!System.Text.RegularExpressions.Regex.IsMatch(AccountUsername,@"^[A-Za-z0-9_.@-]{1,100}$")||!System.Text.RegularExpressions.Regex.IsMatch(AccountBiz,@"^[A-Za-z0-9+/=]{1,200}$")||limit<1||limit>100)throw new Exception("Invalid account request");
      report["author"]=AccountName;report["username"]=AccountUsername;
      Initialize();var profile=Current();

      if(args[0]=="open-card"){
        if(profile==null)throw new Exception("Open the selected official account profile in desktop WeChat first");
        List<string> texts;var cards=Cards(profile,out texts);string key=Convert.ToString(request["cardKey"]);var card=cards.Find(c=>c.Key==key);if(card==null)throw new Exception("The selected article card changed");
        if(IsIconic(profile.Window))ShowWindow(profile.Window,9);SetForegroundWindow(profile.Window);object scroll;
        if(card.Element.TryGetCurrentPattern(ScrollItemPattern.Pattern,out scroll))((ScrollItemPattern)scroll).ScrollIntoView();
        Invoke(card.Element);report["invoked"]=true;report["ok"]=true;
      }else if(args[0]=="read-article"||args[0]=="return-article"){
        string title=Normalize(Convert.ToString(request["title"]));string expected=request.ContainsKey("url")?Convert.ToString(request["url"]):null;
        Profile selected=null;string selectedUrl=null;
        foreach(var d in Documents()){string url=PublicArticle(d.Document);if(url!=null&&Normalize(d.Document.Current.Name)==title&&(expected==null||url==expected)){if(selected!=null)throw new Exception("Multiple matching article documents");selected=d;selectedUrl=url;}}
        if(args[0]=="read-article"){
          report["ready"]=selected!=null;if(selected!=null)report["item"]=new Dictionary<string,object>{{"title",title},{"url",selectedUrl},{"author",AccountName},{"nativeKey",Convert.ToString(request["cardKey"])},{"date",Convert.ToString(request["date"])}};report["ok"]=true;
        }else if(profile!=null){report["alreadyReturned"]=true;report["ok"]=true;}
        else{
          if(selected==null)throw new Exception("The opened article changed before return");
          if(IsIconic(selected.Window))ShowWindow(selected.Window,9);SetForegroundWindow(selected.Window);
          var close=ArticleTabClose(selected);if(close==null)throw new Exception("The article tab close control is not ready");
          Invoke(close);report["invoked"]=true;report["ok"]=true;
        }
      }else if(args[0]=="author-profile"){
        if(profile!=null){report["alreadyReturned"]=true;report["ok"]=true;}
        else{
          AutomationElement name=null;foreach(var d in Documents())if(PublicArticle(d.Document)!=null){foreach(AutomationElement e in d.Document.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Button)))if(e.Current.AutomationId=="js_name"&&Normalize(e.Current.Name)==AccountName){if(name!=null)throw new Exception("Multiple matching account name controls");name=e;}}
          if(name==null)throw new Exception("Open an article or profile for this account in desktop WeChat");Invoke(name);report["invoked"]=true;report["ok"]=true;
        }
      }else if(args[0]=="scroll"){
        if(profile==null)throw new Exception("The account profile changed before scrolling");object scroll;
        if(profile.Document.TryGetCurrentPattern(ScrollPattern.Pattern,out scroll)&&((ScrollPattern)scroll).Current.VerticallyScrollable){((ScrollPattern)scroll).Scroll(ScrollAmount.NoAmount,ScrollAmount.LargeIncrement);report["invoked"]=true;}
        report["ok"]=true;
      }
      if(args[0]=="inspect"){
        report["profileFound"]=profile!=null;var currentArticles=new List<object>();
        foreach(var d in Documents()){string url=PublicArticle(d.Document);if(url!=null)currentArticles.Add(new Dictionary<string,object>{{"title",Normalize(d.Document.Current.Name)},{"url",url}});}
        report["articles"]=currentArticles;
        if(profile!=null){List<string> texts;var cards=Cards(profile,out texts);var titles=new List<object>();foreach(var card in cards)titles.Add(new Dictionary<string,object>{{"title",card.Title},{"key",card.Key}});report["cards"]=titles;report["complete"]=texts.Exists(t=>System.Text.RegularExpressions.Regex.IsMatch(t,"^(没有更多|已显示全部|全部已加载|暂无更多|全部内容已加载)[。！.!]?$"));}
        report["ok"]=true;
      }
    }catch(Exception e){report["error"]=e.GetType().Name;report["stage"]=Stage;}
    Emit(new Dictionary<string,object>{{"kind","result"},{"value",report}});
  }
}
