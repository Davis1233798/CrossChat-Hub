using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

// A separate controller/guardian and two owned fixture processes only.
// No CLI to attach, terminate, or inspect any external application.
internal static class CrashStudy {
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child,IntPtr parent);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetStyle(IntPtr window,int index);
  [DllImport("user32.dll",EntryPoint="SetWindowLongPtrW")] static extern IntPtr SetStyle(IntPtr window,int index,IntPtr value);
  [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr window,ref Placement placement);
  [DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr window,ref Placement placement);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [StructLayout(LayoutKind.Sequential)] struct Placement { public int Length,Flags,ShowCmd; public Point Min,Max; public Rect Normal; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
  static IntPtr AwaitWindow(Process process) {
    for(int i=0;i<100;i++) { process.Refresh(); if(process.HasExited)throw new Exception("Owned fixture exited early"); if(process.MainWindowHandle!=IntPtr.Zero)return process.MainWindowHandle; Thread.Sleep(100); }
    throw new Exception("Owned fixture did not create its window");
  }
  static bool OwnedWindow(IntPtr hwnd,Process process) { uint pid; return IsWindow(hwnd)&&GetWindowThreadProcessId(hwnd,out pid)!=0&&pid==(uint)process.Id; }
  [STAThread] static int Main(string[] args) {
    Application.EnableVisualStyles();
    if(args.Length==2 && args[0]=="--fixture" && (args[1]=="host"||args[1]=="child")) {
      var form=new Form { Text="CrossChat crash-study owned "+args[1],Width=640,Height=400 };
      form.Controls.Add(new Label { Text="Synthetic crash study only. No chat applications.",Dock=DockStyle.Fill });
      Application.Run(form);return 0;
    }
    if(args.Length!=2||args[0]!="--output"||!Path.IsPathRooted(args[1]))return 2;
    Process host=null,child=null; IntPtr childWindow=IntPtr.Zero,oldParent=IntPtr.Zero,oldStyle=IntPtr.Zero;
    Placement placement=new Placement { Length=Marshal.SizeOf(typeof(Placement)) };
    bool embedded=false,hostExited=false,childSurvived=false,restored=false,childClosed=false,forcedFixtureCleanup=false; string error=null;
    try {
      // The controller is the independent guardian. Both fixture processes are
      // created here; Process objects retain OS handles, avoiding PID reuse.
      child=Process.Start(new ProcessStartInfo(Application.ExecutablePath,"--fixture child") { UseShellExecute=false });
      host=Process.Start(new ProcessStartInfo(Application.ExecutablePath,"--fixture host") { UseShellExecute=false });
      childWindow=AwaitWindow(child);IntPtr hostWindow=AwaitWindow(host);
      if(!OwnedWindow(childWindow,child)||!OwnedWindow(hostWindow,host))throw new Exception("Fixture HWND ownership mismatch");
      oldParent=GetParent(childWindow);oldStyle=GetStyle(childWindow,-16);GetWindowPlacement(childWindow,ref placement);
      SetStyle(childWindow,-16,new IntPtr((oldStyle.ToInt64()|0x40000000L)&~0x80000000L));
      SetParent(childWindow,hostWindow);embedded=GetParent(childWindow)==hostWindow;
      if(!embedded)throw new Exception("Synthetic embedding failed");
      // Intentional hard crash of this controller's own synthetic host only.
      host.Kill();hostExited=host.WaitForExit(5000);
      childSurvived=OwnedWindow(childWindow,child)&&!child.HasExited;
      if(childSurvived) {
        SetParent(childWindow,oldParent);SetStyle(childWindow,-16,oldStyle);SetWindowPlacement(childWindow,ref placement);
        Placement observed=new Placement { Length=Marshal.SizeOf(typeof(Placement)) };GetWindowPlacement(childWindow,ref observed);
        restored=GetParent(childWindow)==oldParent&&GetStyle(childWindow,-16)==oldStyle&&observed.Normal.Equals(placement.Normal)&&observed.ShowCmd==placement.ShowCmd&&IsWindowVisible(childWindow);
      }
    }catch(Exception ex){error=ex.Message;}
    finally {
      // Restore again before fixture shutdown if an earlier phase threw.
      if(child!=null && !child.HasExited && OwnedWindow(childWindow,child)) {
        if(embedded&&!restored){SetParent(childWindow,oldParent);SetStyle(childWindow,-16,oldStyle);SetWindowPlacement(childWindow,ref placement);}
        child.CloseMainWindow();childClosed=child.WaitForExit(5000);
      } else childClosed=child!=null&&child.HasExited;
      // A destroyed HWND can leave the owned fixture process alive without a
      // normal-close target. Terminate ONLY this process we created ourselves;
      // report forced cleanup separately, never count it as normal closure.
      if(child!=null&&!child.HasExited){child.Kill();child.WaitForExit(5000);forcedFixtureCleanup=true;}
      if(host!=null&&!host.HasExited){host.CloseMainWindow();host.WaitForExit(5000);}
    }
    Func<bool,string> b=value=>value?"true":"false";
    Func<string,string> q=value=>value==null?"null":"\""+value.Replace("\\","\\\\").Replace("\"","\\\"")+"\"";
    File.WriteAllText(args[1],"{\"embedded\":"+b(embedded)+",\"syntheticHostHardExit\":"+b(hostExited)+",\"childWindowSurvived\":"+b(childSurvived)+",\"guardianRestoreVerified\":"+b(restored)+",\"childNormallyClosed\":"+b(childClosed)+",\"forcedOwnedFixtureCleanup\":"+b(forcedFixtureCleanup)+",\"error\":"+q(error)+"}");
    return embedded&&hostExited&&childSurvived&&restored&&childClosed&&error==null?0:1;
  }
}
