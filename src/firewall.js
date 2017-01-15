"use strict"
const os = require('os');
const iptables = require('tesserarius')();
const cron = require('node-cron');

// Parses and executes CLI commands
function execCmd(str, cb) {
	let cmd = str.split(' ');
	cmd = {
		exec: cmd[0],
		args: cmd.slice(1, cmd.length)
	};

	const cp = child_process.spawn(cmd.exec, cmd.args);
    cp.on('close', (code) => {
        if(code !== 0)
            cb( new Error(`Process returned exit code: ${code}`) );
        else
            cb();
    });
}

// Set a Cron job to reset the firewall at midnight, every day
let taskActive = false;
const task = cron.schedule('0 0 0 * * *', () => {
	console.log("Flushing allowed devices...");
	module.exports.flush((err) => {
		if(err)
			console.error("Error while restarting firewall:\n" + err.stack);
		else
			console.log("Auth devices flushed successfully");
	});
});

module.exports = {
	// Sets the firewall rules
	init: (cb) => {
		// Get the router IP
		let routerIp = global.config.routerIp;

		async.series([
			// Flushes the chains
			(cb2) => {
				execCmd("iptables -F", cb2);
			},
			// Sets the rules
			(cb2) => {
				let cmd = [];
				cmd.concat([
					// Mangling rules (for MAC filtering)
					"iptables -t mangle -N wlan0_Trusted",
					"iptables -t mangle -N wlan0_Outgoing",
					"iptables -t mangle -N wlan0_Incoming",
					`iptables -t mangle -I PREROUTING 1 -i ${config.global.lanIf} -j wlan0_Outgoing`,
					`iptables -t mangle -I PREROUTING 1 -i ${config.global.lanIf} -j wlan0_Trusted`,
					`iptables -t mangle -I POSTROUTING 1 -o ${config.global.lanIf} -j wlan0_Incoming`,
					// Set NAT rules
					"iptables -t nat -N wlan0_Outgoing",
					"iptables -t nat -N wlan0_Router",
					"iptables -t nat -N wlan0_Internet",
					"iptables -t nat -N wlan0_UnknownDevices",
					"iptables -t nat -N wlan0_WhitelistServers",
					`iptables -t nat -A PREROUTING -i ${config.global.lanIf} -j wlan0_Outgoing`,
					// Accepts connections to the router
					`iptables -t nat -A wlan0_Outgoing -d ${routerIp} ACCEPT`,
					// Accepts outgoing connections from authorized MACs
					"iptables -t nat -A wlan0_Outgoing -j wlan0_Internet",
					"iptables -t nat -A wlan0_Internet -m mark --mark 0x2 -j ACCEPT",
					// Accepts all unauthorized connections going to...
					"iptables -t nat -A wlan0_Internet -j wlan0_UnknownDevices",
					// ...authorized servers...
					"iptables -t nat -A wlan0_UnknownDevices -j wlan0_WhitelistServers",
					// ...and redirects all other HTTP(S) requests to the captive portal
					`iptables -t nat -A wlan0_UnknownDevices -p tcp --dport 80 -j DNAT --to-destination ${routerIp}:${global.config.port}`,
					`iptables -t nat -A wlan0_UnknownDevices -p tcp --dport 443 -j DNAT --to-destination ${routerIp}:${global.config.port}`,
					// Filtering chains
					"iptables -t filter -N wlan0_Internet",
					"iptables -t filter -N wlan0_WhitelistServers",
					"iptables -t filter -N wlan0_KnownDevices",
					"iptables -t filter -N wlan0_UnknownDevices",
					// Outgoing rules for forwarded packets
					`iptables -t filter -I FORWARD -i ${config.global.lanIf} -j wlan0_Internet`,
					// Drop invalid packets
					"iptables -t filter -A wlan0_Internet -m state --state INVALID -j DROP"
					// Adapts segment size to avoid connection problems with big packets
					//"iptables -t filter -A wlan0_Internet -o eth0.2 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu"
				]);

				// Accept connections to whiteliste servers
				cmd.push("iptables -t filter -A wlan0_Internet -j wlan0_WhitelistServers");
				cmd.push(`iptables -t filter -A wlan0_WhitelistServers -d ${routerIp} -j ACCEPT`);	// router
				global.config.whitelist.forEach((addr) => {											// user-defined whitelist
					cmd.push(`iptables -t filter -A wlan0_WhitelistServers -d ${addr} -j ACCEPT`);
				});

				cmd.concat([
					// Accept connections from authorized devices
					"iptables -t filter -A wlan0_Internet -m mark --mark 0x2 -j wlan0_KnownDevices",
					"iptables -t filter -A wlan0_KnownDevices -d 0.0.0.0/0 -j ACCEPT",
					// Deal with all other unauthorized devices
					"iptables -t filter -A wlan0_Internet -j wlan0_UnknownDevices",
					// Allow all DNS
					"iptables -t filter -A wlan0_UnknownDevices -d 0.0.0.0/0 -p udp --dport 53 -j ACCEPT",
					"iptables -t filter -A wlan0_UnknownDevices -d 0.0.0.0/0 -p tcp --dport 53 -j ACCEPT",
					"iptables -t filter -A wlan0_UnknownDevices -d 0.0.0.0/0 -p udp --dport 67 -j ACCEPT",
					"iptables -t filter -A wlan0_UnknownDevices -d 0.0.0.0/0 -p tcp --dport 67 -j ACCEPT",
					// Reject everything else
					"iptables -t filter -A wlan0_UnknownDevices -j REJECT --reject-with icmp-port-unreachable",
					"iptables -t nat -A POSTROUTING -o eth0.2 -j MASQUERADE"
				]);

				// Applies the firewall settings
				async.eachSeries(cmd, (cmd, cb3) => execCmd(cmd, cb3), c2);
			}
		], (err) => {
			if(err)
				cb(err);
			else {
				// Schedules the automatic firewall reset
				if(!taskActive) {
					task.start();
					taskActive = true;
				}

				cb();
			}
		});
	},

	// Authorizes a device to access the network
	authorize: (mac, cb) => {
		execCmd(`iptables -t mangle -A wlan0_Outgoing -m mac --mac-source "${mac}" -j MARK --set-mark 2`, cb);
	},

	// Flushes the list of authenticated MACs
	flush: (cb) => {
		execCmd("iptables -t mangle -F wlan0_Outgoing", cb);
	}
}