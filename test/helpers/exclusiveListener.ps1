param([string]$Ports, [string]$Greeting = 'foreign listener')

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading.Tasks;

public static class ExclusiveListener {
    public static void Run(int[] ports, string greeting) {
        var listeners = new List<TcpListener>();
        byte[] payload = Encoding.ASCII.GetBytes(greeting + "\n");
        try {
            foreach (int port in ports) {
                var listener = new TcpListener(IPAddress.Any, port);
                listener.Server.ExclusiveAddressUse = true;
                listener.Start();
                listeners.Add(listener);
                Task.Run(async () => {
                    try {
                        while (true) {
                            using (var client = await listener.AcceptTcpClientAsync()) {
                                await client.GetStream().WriteAsync(payload, 0, payload.Length);
                            }
                        }
                    } catch (SocketException) {
                        // Stopping the listener interrupts AcceptTcpClientAsync.
                    } catch (ObjectDisposedException) {
                    }
                });
            }
            Console.WriteLine("READY");
            Console.Out.Flush();
            Console.ReadLine();
        } finally {
            foreach (var listener in listeners) listener.Stop();
        }
    }
}
'@

[ExclusiveListener]::Run([int[]]$Ports.Split(','), $Greeting)
