using System;
using System.Diagnostics;
using System.IO;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Automation;
using System.Windows.Interop;
using System.Windows.Threading;
internal static class SyntheticRouting {
  [STAThread] static int Main(string[] args) {
    if (args.Length != 1) return 2;
    Application app = new Application();
    Window window = new Window { Title = "Owned routing fixture", Width = 600, Height = 320 };
    StackPanel panel = new StackPanel();
    TextBlock header = new TextBlock { Text = "合成聊天室", Margin = new Thickness(20) };
    AutomationProperties.SetAutomationId(header, "chatHeader");
    TextBox text = new TextBox { Text = "Only owned selected text", Margin = new Thickness(20), Height = 120, AcceptsReturn = true };
    panel.Children.Add(header); panel.Children.Add(text); window.Content = panel;
    window.ContentRendered += delegate {
      text.Focus(); text.SelectAll();
      using (Process p = Process.GetCurrentProcess()) File.WriteAllText(args[0], new JavaScriptSerializer().Serialize(new { pid = p.Id, startTicks = p.StartTime.ToUniversalTime().Ticks.ToString(), exe = p.MainModule.FileName, hwnd = new WindowInteropHelper(window).Handle.ToInt64().ToString() }));
    };
    DispatcherTimer deadline = new DispatcherTimer { Interval = TimeSpan.FromSeconds(30) }; deadline.Tick += delegate { window.Close(); }; deadline.Start();
    app.Run(window); return 0;
  }
}
