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

// Product helper: inspect only WeChat-owned browser documents and refresh only
// a verified Channels document through its own toolbar menu. No key injection,
// foreground activation, network, certificates, cookies or chat-content reads.
public static class FengshaWeChatWindow {
  delegate bool EnumWindow(IntPtr window,IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback,IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint processId);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window,uint command);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int count);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr window);
  static volatile string Stage="starting";
  static volatile bool RefreshAttempted=false;
  static int NodesVisited=0;
  static bool UnsupportedDocumentOwner=false;
  static bool DocumentQueryFailed=false;
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
  static bool OfficialDocument(string value,out string path) {
    path=null;Uri url;
    if(String.IsNullOrEmpty(value)||!Uri.TryCreate(value,UriKind.Absolute,out url)||url.Scheme!="https"||url.Host!="channels.weixin.qq.com"||!url.IsDefaultPort||!String.IsNullOrEmpty(url.UserInfo)||!url.AbsolutePath.StartsWith("/web/pages/",StringComparison.Ordinal))return false;
    // No auth query, fragment or title is returned to the parent process.
    path=url.GetLeftPart(UriPartial.Path);return true;
  }
  static bool Owned(IntPtr window,uint process) {
    if(!IsWindow(window))return false;uint id;GetWindowThreadProcessId(window,out id);
    if(id!=process)return DocumentOwner(process,(int)id);
    try { using(var p=Process.GetProcessById((int)id))return WeChatProcess(p.ProcessName); }catch{return false;}
  }
  static ProcessMetadata WindowRoot(ProcessMetadata owner,IEnumerable<ProcessMetadata> roots,Func<uint,ProcessMetadata> lookup,Func<string,bool> signed) {
    if(owner==null)return null;
    foreach(var root in roots)if(BrowserChain(root,owner,lookup,signed))return root;
    return null;
  }
  static string MissingDocumentStatus(int count,bool queryFailed) {return queryFailed?"unsupported-document-query":count>0?"unsupported-document-url":"not-found";}
  static bool DocumentURL(AutomationElement document,out string path) {
    path=null;
    if(document.Current.ControlType!=ControlType.Document||document.Current.Name!="视频号"||document.Current.AutomationId!="RootWebArea")return false;
    Stage="document-url";
    object pattern;
    if(document.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)&&OfficialDocument(((ValuePattern)pattern).Current.Value,out path))return true;
    // Older Framework UIA clients do not expose the legacy pattern class. If
    // the runtime knows its documented Value property, read only that field;
    // otherwise leave the document unverified instead of guessing from a title.
    var legacyValue=AutomationProperty.LookupById(30093);
    if(legacyValue!=null&&OfficialDocument(document.GetCurrentPropertyValue(legacyValue,true) as string,out path))return true;
    return false;
  }
  static List<Candidate> Candidates(out int documentCount) {
    var found=new List<Candidate>();int observed=0;
    Stage="process-filter";var allowedProcesses=new HashSet<uint>();var roots=new List<ProcessMetadata>();
    foreach(var name in new[]{"Weixin","WeChat","WeChatAppEx"})foreach(var item in Process.GetProcessesByName(name))using(item){try{allowedProcesses.Add((uint)item.Id);if(WeChatProcess(name)){var metadata=Metadata((uint)item.Id);if(RegisteredRoot(metadata))roots.Add(metadata);}}catch(InvalidOperationException){}}
    EnumWindows((window,parameter)=>{
      Stage="window-filter";uint process;GetWindowThreadProcessId(window,out process);if(!allowedProcesses.Contains(process)||GetWindowTextLength(window)!=2)return true;
      var caption=new StringBuilder(4);GetWindowText(window,caption,caption.Capacity);if(caption.ToString()!="微信")return true;
      // Modern WeChat hosts browser windows in its signed WMPF child process.
      // Establish ancestry before requesting any UI from that window.
      var ownerRoot=WindowRoot(Metadata(process),roots,Metadata,TencentSigned);if(ownerRoot==null)return true;process=ownerRoot.Id;
      if(!Owned(window,process))return true;
      try {
        Stage="window-properties";
        var root=AutomationElement.FromHandle(window);
        if(root.Current.Name!="微信")return true;
        // Request only the exact public Channels document from the provider.
        // No structural walk, control-list enumeration, other names, text or
        // inaccessible/private UI descendants are returned to this client.
        Stage="document-query";
        var documentCondition=new AndCondition(new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Document),new PropertyCondition(AutomationElement.NameProperty,"视频号"),new PropertyCondition(AutomationElement.AutomationIdProperty,"RootWebArea"));
        var documents=root.FindAll(TreeScope.Descendants,documentCondition);NodesVisited+=documents.Count;
        foreach(AutomationElement doc in documents){string path;observed++;if(!DocumentOwner(process,doc.Current.ProcessId)){UnsupportedDocumentOwner=true;continue;}if(DocumentURL(doc,out path))found.Add(new Candidate {Window=window,Process=process,Root=root,Document=doc,Path=path});}
      }catch(ElementNotAvailableException){DocumentQueryFailed=true;}catch(InvalidOperationException){DocumentQueryFailed=true;}
      return true;
    },IntPtr.Zero);documentCount=observed;return found;
  }
  static bool Revalidate(Candidate target) {
    string path;return Owned(target.Window,target.Process)&&DocumentOwner(target.Process,target.Document.Current.ProcessId)&&DocumentURL(target.Document,out path)&&path==target.Path;
  }
  static List<AutomationElement> Buttons(AutomationElement root,string name,bool menu) {
    var result=new List<AutomationElement>();
    var match=new AndCondition(new PropertyCondition(AutomationElement.NameProperty,name),new OrCondition(new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Button),new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.MenuItem)));
    foreach(AutomationElement element in root.FindAll(TreeScope.Children,match)) {
      if(element.Current.IsEnabled&&!element.Current.IsOffscreen&&element.Current.ProcessId==root.Current.ProcessId&&element.GetSupportedPatterns()!=null)result.Add(element);
    }
    return result;
  }
  static bool OutsideDocument(AutomationElement element,AutomationElement boundary) {
    for(var node=element;node!=null;node=TreeWalker.ControlViewWalker.GetParent(node)) {
      if(node.Current.ControlType==ControlType.Document)return false;
      if(Automation.Compare(node,boundary))return true;
    }
    return false;
  }
  static bool ContainerType(ControlType type) {return type==ControlType.Pane||type==ControlType.Group||type==ControlType.Custom||type==ControlType.ToolBar;}
  static Condition ToolbarCondition() {
    return new OrCondition(new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.ToolBar),new AndCondition(new OrCondition(new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Pane),new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Group),new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Custom)),new OrCondition(new PropertyCondition(AutomationElement.NameProperty,"toolbar"),new PropertyCondition(AutomationElement.AutomationIdProperty,"toolbar"))));
  }
  static ToolbarResult More(Candidate target) {
    // Search only direct siblings on this verified Document's ancestor chain.
    // WMPF ancestors are allowed only after the exact same signed ancestry
    // validation; never rescan the whole root window or enter a Document.
    var result=new ToolbarResult();var owners=new Dictionary<int,bool>();
    var timer=Stopwatch.StartNew();
    for(var scope=TreeWalker.ControlViewWalker.GetParent(target.Document);scope!=null;scope=TreeWalker.ControlViewWalker.GetParent(scope)) {
      if(++result.Ancestors>24||timer.ElapsedMilliseconds>2500){result.Limited=true;break;}
      int process=scope.Current.ProcessId;bool owner;if(!owners.TryGetValue(process,out owner)){owner=process==(int)target.Process||DocumentOwner(target.Process,process);owners[process]=owner;}if(!owner){result.OwnerRejected++;break;}
      Stage="toolbar";var areas=scope.FindAll(TreeScope.Children,ToolbarCondition());
      var matches=new List<AutomationElement>();
      foreach(AutomationElement area in areas){result.Toolbars++;if(result.Toolbars>16){result.Limited=true;break;}if(!OutsideDocument(area,target.Root))continue;int pid=area.Current.ProcessId;if(pid!=(int)target.Process&&!DocumentOwner(target.Process,pid)){result.OwnerRejected++;continue;}
        // Native toolbar wrappers may be one or two structural panes; this is
        // bounded to that toolbar, and cannot traverse the webpage or chats.
        var queue=new Queue<KeyValuePair<AutomationElement,int>>();queue.Enqueue(new KeyValuePair<AutomationElement,int>(area,0));int nodes=0;
        while(queue.Count>0&&nodes++<16){var item=queue.Dequeue();foreach(var button in Buttons(item.Key,"更多",false))if(!matches.Exists(e=>Automation.Compare(e,button)))matches.Add(button);if(item.Value<2)foreach(AutomationElement child in item.Key.FindAll(TreeScope.Children,Condition.TrueCondition))if(ContainerType(child.Current.ControlType))queue.Enqueue(new KeyValuePair<AutomationElement,int>(child,item.Value+1));}
        if(queue.Count>0)result.Limited=true;
      }
      result.Buttons+=matches.Count;
      if(result.Limited)break;
      if(matches.Count>0){if(matches.Count==1){result.Button=matches[0];result.Container=scope;}return result;}
      if(Automation.Compare(scope,target.Root))break;
    }
    return result;
  }
  static bool IsOwnedPopup(IntPtr popup,Candidate target) {
    if(!IsWindow(popup)||popup==target.Window)return false;
    // Establish exact native owner relation first; never query unrelated
    // desktop process metadata while enumerating candidate popup handles.
    bool linked=false;var owner=GetWindow(popup,4);for(int i=0;i<8&&owner!=IntPtr.Zero;i++){if(owner==target.Window||GetAncestor(owner,3)==target.Window){linked=true;break;}owner=GetWindow(owner,4);}if(!linked)return false;
    uint process;GetWindowThreadProcessId(popup,out process);return process==target.Process||DocumentOwner(target.Process,(int)process);
  }
  static List<AutomationElement> RefreshButtons(Candidate target,AutomationElement container,out bool limited) {
    // Require a menu subtree. A webpage's arbitrary button named 刷新 never qualifies.
    var scopes=new List<AutomationElement>{container};limited=false;
    EnumWindows((window,parameter)=>{if(IsOwnedPopup(window,target)){try{scopes.Add(AutomationElement.FromHandle(window));}catch(ElementNotAvailableException){}}return true;},IntPtr.Zero);
    var result=new List<AutomationElement>();int count=0;foreach(var scope in scopes) {
      Stage="menu";var menus=new List<AutomationElement>();var queue=new Queue<KeyValuePair<AutomationElement,int>>();queue.Enqueue(new KeyValuePair<AutomationElement,int>(scope,0));
      while(queue.Count>0&&count++<64){var item=queue.Dequeue();if(item.Key.Current.ControlType==ControlType.Document)continue;if(item.Key.Current.ControlType==ControlType.Menu)menus.Add(item.Key);if(item.Value<4)foreach(AutomationElement child in item.Key.FindAll(TreeScope.Children,Condition.TrueCondition))if(child.Current.ControlType!=ControlType.Document&&(ContainerType(child.Current.ControlType)||child.Current.ControlType==ControlType.Menu))queue.Enqueue(new KeyValuePair<AutomationElement,int>(child,item.Value+1));}
      if(queue.Count>0){limited=true;break;}
      foreach(AutomationElement menu in menus)if(OutsideDocument(menu,scope))foreach(var button in Buttons(menu,"刷新",true))if(!result.Exists(e=>Automation.Compare(e,button)))result.Add(button);
    }
    return result;
  }
  static bool Invoke(AutomationElement element) { object pattern;if(!element.TryGetCurrentPattern(InvokePattern.Pattern,out pattern))return false;((InvokePattern)pattern).Invoke();return true; }
  static object Run(string action) {
    int documentCount;var candidates=Candidates(out documentCount);var report=new Dictionary<string,object>{{"ok",true},{"action",action},{"matched",candidates.Count},{"candidateDocuments",documentCount},{"nodesVisited",NodesVisited},{"refreshAttempted",false},{"refreshed",false}};
    if(UnsupportedDocumentOwner){report["status"]="unsupported-document-owner";return report;}
    if(candidates.Count!=1){report["status"]=candidates.Count==0?MissingDocumentStatus(documentCount,DocumentQueryFailed):"ambiguous";return report;}
    var target=candidates[0];report["url"]=target.Path;report["processId"]=target.Process;
    if(!Revalidate(target)){report["status"]="changed";return report;}
    var toolbar=More(target);var more=toolbar.Button;object invocation;bool canOpen=more!=null&&more.TryGetCurrentPattern(InvokePattern.Pattern,out invocation);report["toolbarAvailable"]=canOpen;report["toolbarAncestors"]=toolbar.Ancestors;report["toolbarCandidates"]=toolbar.Toolbars;report["moreCandidates"]=toolbar.Buttons;report["toolbarOwnerRejected"]=toolbar.OwnerRejected;
    if(toolbar.Limited){report["ok"]=false;report["status"]="scan-limited";return report;}
    if(action=="inspect"){report["status"]="found";return report;}
    if(!canOpen){report["status"]="unsupported-toolbar";return report;}
    if(!Revalidate(target)){report["status"]="changed";return report;}
    if(!Invoke(more)){report["status"]="unsupported-toolbar";return report;}
    report["menuOpened"]=true;List<AutomationElement> buttons=null;
    bool menuLimited=false;for(int i=0;i<8;i++){Thread.Sleep(100);if(!Revalidate(target)){report["status"]="changed";return report;}buttons=RefreshButtons(target,toolbar.Container,out menuLimited);if(menuLimited||buttons.Count>0)break;}
    if(menuLimited){report["ok"]=false;report["status"]="scan-limited";return report;}
    if(buttons==null||buttons.Count!=1){report["status"]=buttons!=null&&buttons.Count>1?"ambiguous-menu":"unsupported-menu";return report;}
    if(!Revalidate(target)){report["status"]="changed";return report;}
    report["refreshAttempted"]=true;RefreshAttempted=true;Stage="refresh-invoke";
    if(!Invoke(buttons[0])){report["status"]="unsupported-invoke";return report;}
    report["refreshed"]=true;report["status"]="invoked";return report;
  }
  static object SelfTest() {
    string p;bool passed=OfficialDocument("https://channels.weixin.qq.com/web/pages/home?auth=NEVER_EXPORT",out p)&&p=="https://channels.weixin.qq.com/web/pages/home";
    foreach(var value in new[]{"http://channels.weixin.qq.com/web/pages/home","https://channels.weixin.qq.com.evil.example/web/pages/home","https://user:pass@channels.weixin.qq.com/web/pages/home","https://channels.weixin.qq.com:444/web/pages/home","https://channels.weixin.qq.com/web/pages-evil/home","https://channels.weixin.qq.com/web/pages/../private"})passed&=!OfficialDocument(value,out p);
    passed&=WeChatProcess("Weixin")&&WeChatProcess("wechat")&&!WeChatProcess("WeixinHelper")&&!WeChatProcess("chrome");
    var root=new ProcessMetadata{Id=1,Path=@"D:\Program Files\Tencent\Weixin\Weixin.exe",Created=new DateTime(2026,1,1)};
    var plugin=new ProcessMetadata{Id=2,Parent=1,Path=PluginPath(),Created=new DateTime(2026,1,2)};var child=new ProcessMetadata{Id=3,Parent=2,Path=PluginPath(),Created=new DateTime(2026,1,3)};
    Func<uint,ProcessMetadata> lookup=id=>id==1?root:id==2?plugin:null;
    passed&=BrowserChain(root,child,lookup,path=>true);
    passed&=!BrowserChain(root,child,lookup,path=>false);
    passed&=!BrowserChain(root,new ProcessMetadata{Id=3,Parent=1,Path=@"C:\Other\WeChatAppEx.exe",Created=child.Created},lookup,path=>true);
    passed&=!BrowserChain(root,new ProcessMetadata{Id=3,Parent=999,Path=PluginPath(),Created=child.Created},lookup,path=>true);
    passed&=!BrowserChain(root,new ProcessMetadata{Id=3,Parent=1,Path=PluginPath(),Created=new DateTime(2025,1,1)},lookup,path=>true);
    passed&=!BrowserChain(root,new ProcessMetadata{Id=2,Parent=2,Path=PluginPath(),Created=plugin.Created},id=>plugin,path=>true);
    passed&=WindowRoot(root,new[]{root},lookup,path=>true)==root;
    passed&=WindowRoot(child,new[]{root},lookup,path=>true)==root;
    passed&=WindowRoot(child,new[]{root},lookup,path=>false)==null;
    passed&=WindowRoot(new ProcessMetadata{Id=3,Parent=1,Path=@"C:\Other\WeChatAppEx.exe",Created=child.Created},new[]{root},lookup,path=>true)==null;
    passed&=MissingDocumentStatus(0,false)=="not-found"&&MissingDocumentStatus(0,true)=="unsupported-document-query"&&MissingDocumentStatus(1,false)=="unsupported-document-url";
    return new {ok=passed,action="self-test",status=passed?"passed":"failed",uiAccessed=false,threadModel=Thread.CurrentThread.GetApartmentState().ToString(),ownershipChecks=6,standaloneWindowChecks=4,documentQueryChecks=3};
  }
  [MTAThread] public static int Main(string[] args) {
    object result=null;
    if(args.Length!=1||args[0]!="inspect"&&args[0]!="refresh"&&args[0]!="self-test")result=new{ok=false,status="invalid-action"};
    else if(args[0]=="self-test")result=SelfTest();
    else{
      // A dedicated windowless MTA worker avoids UI-thread/STA message conflicts.
      // UIA providers can block one call indefinitely, so cap the owned helper
      // process independently of the per-walk budget. Never terminate WeChat.
      var worker=new Thread(()=>{try{result=Run(args[0]);}catch(Exception e){result=new{ok=false,status="unavailable",errorType=e.GetType().Name};}});worker.IsBackground=true;worker.SetApartmentState(ApartmentState.MTA);worker.Start();
      if(!worker.Join(args[0]=="refresh"?8000:4000))result=new{ok=false,status="timeout",stage=Stage,refreshAttempted=RefreshAttempted,refreshed=false,matched=0};
    }
    Console.OutputEncoding=new System.Text.UTF8Encoding(false);Console.WriteLine(new JavaScriptSerializer().Serialize(result));Console.Out.Flush();Environment.Exit(0);return 0;
  }
}
