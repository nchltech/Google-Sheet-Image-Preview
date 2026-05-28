function ensureContextMenu() {
	try {
		chrome.contextMenus.create({
			id: 'shp-open-original',
			title: 'Open original image',
			contexts: ['image']
		});
	} catch (e) {
		// If the menu already exists or creation fails, ignore silently.
	}
}

chrome.runtime.onInstalled.addListener(function () {
	console.log("SHP v11");
	ensureContextMenu();
});

chrome.runtime.onStartup.addListener(function () {
	ensureContextMenu();
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(function (info, tab) {
	if (info.menuItemId === 'shp-open-original' && info.srcUrl) {
		chrome.tabs.create({ url: info.srcUrl });
	}
});

// Handle keyboard commands (e.g. toggle overlay)
chrome.commands.onCommand.addListener(function (command) {
	if (command === 'toggle-overlay') {
		// Broadcast message to all tabs to toggle overlay
		chrome.tabs.query({}, function (tabs) {
			tabs.forEach(function (t) {
				try { chrome.tabs.sendMessage(t.id, { cmd: 'toggleOverlay' }); } catch (e) {}
			});
		});
	}
});