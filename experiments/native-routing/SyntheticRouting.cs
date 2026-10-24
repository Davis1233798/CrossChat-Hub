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
    if (args.Length != 1 && (args.Length != 2 || args[1] != "--preselected-owned")) return 2;
    bool preselected = args.Length == 2;
    Application app = new Application();
    Window window = new Window { Title = "Owned routing fixture", Width = 600, Height = 320 };
    StackPanel panel = new StackPanel();
    TextBlock header = new TextBlock { Text = "合成聊天室", Margin = new Thickness(20) };
    AutomationProperties.SetAutomationId(header, "chatHeader");
    TextBox text = new TextBox { Text = "Only owned selected text", Margin = new Thickness(20), Height = 120, AcceptsReturn = true, IsReadOnly = preselected };
    AutomationProperties.SetAutomationId(text, "messageSelection");
    panel.Children.Add(header); panel.Children.Add(text); window.Content = panel;
    window.ContentRendered += delegate {
      if (preselected) { window.Activate(); System.Windows.Input.Keyboard.Focus(text); }
      text.Focus(); text.SelectAll();
      using (Process p = Process.GetCurrentProcess()) File.WriteAllText(args[0], new JavaScriptSerializer().Serialize(new { pid = p.Id, startTicks = p.StartTime.ToUniversalTime().Ticks.ToString(), exe = p.MainModule.FileName, hwnd = new WindowInteropHelper(window).Handle.ToInt64().ToString(), preselected, active = window.IsActive, focused = text.IsKeyboardFocused, selectionLength = text.SelectionLength }));
    };
    DispatcherTimer control = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
    control.Tick += delegate {
      if (File.Exists(args[0] + ".close")) window.Close();
      if (preselected && File.Exists(args[0] + ".select")) {
        File.Delete(args[0] + ".select"); window.Activate(); System.Windows.Input.Keyboard.Focus(text); text.SelectAll();
        File.WriteAllText(args[0] + ".selected", window.IsActive && text.IsKeyboardFocused && text.SelectionLength == text.Text.Length ? "selected" : "not-focused");
      }
    }; control.Start();
    DispatcherTimer deadline = new DispatcherTimer { Interval = TimeSpan.FromSeconds(30) }; deadline.Tick += delegate { window.Close(); }; deadline.Start();
    app.Run(window); return 0;
  }
}
