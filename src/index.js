const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config.json');


puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));

const CONFIG = {
    PARENT_URL: config.PARENT_URL,
    CHECK_INTERVAL: config.CHECK_INTERVAL, // 24 hours
};

let monitorState = {
    browser: null,
    page: null,
    cookies: null, // Store cookies for HTTP requests
};

const initBrowser = async () => {
    console.log('Starting Chrono24.com Monitor (with pagination)...');
    monitorState.browser = await puppeteer.launch({
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=VizDisplayCompositor',
            '--disable-web-security',
            '--disable-features=site-per-process',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-zygote',
            '--disable-gpu'
        ]
    });
    monitorState.page = await monitorState.browser.newPage();

    await monitorState.page.setViewport({ width: 1366, height: 768 });

    await monitorState.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await monitorState.page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0'
    });

    await monitorState.page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
        });
    });

    console.log('Browser initialized with stealth mode');
}

// Get cookies from browser and format them for HTTP requests
const getCookiesFromBrowser = async () => {
    if (!monitorState.page) {
        throw new Error('Browser page not initialized');
    }
    
    try {
        // Navigate to the parent URL to get cookies
        await monitorState.page.goto(CONFIG.PARENT_URL, {
            waitUntil: 'networkidle2',
            timeout: 90000
        });
        
        // Wait for page to fully load and any JavaScript to set cookies
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Wait for Cloudflare challenge if present
        let cloudflareCheckCount = 0;
        const maxCloudflareChecks = 10;
        
        while (cloudflareCheckCount < maxCloudflareChecks) {
            const isCloudflareChallenge = await monitorState.page.evaluate(() => {
                return document.title.includes('Just a moment') ||
                    document.querySelector('cf-challenge') !== null ||
                    document.querySelector('.cf-browser-verification') !== null ||
                    document.querySelector('#challenge-form') !== null;
            });

            if (isCloudflareChallenge) {
                console.log(`Waiting for page to load... (${cloudflareCheckCount + 1}/${maxCloudflareChecks})`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                cloudflareCheckCount++;
            } else {
                break;
            }
        }
        
        // Wait a bit more for all cookies to be set (especially JavaScript-set cookies)
        // Some cookies are set after page load by JavaScript
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Get ALL cookies from the page - this gets all cookies for the current domain
        const cookies = await monitorState.page.cookies();
        
        // Format cookies as a cookie string
        const cookieString = cookies
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ');
        
        monitorState.cookies = cookieString;
        console.log(`✅ Retrieved ${cookies.length} cookies`);
        
        return cookieString;
    } catch (error) {
        console.error('Error getting cookies from browser:', error.message);
        throw error;
    }
}

// Fetch HTML content via HTTP request using Puppeteer's CDP (to use browser's network stack)
const fetchPageHtml = async (url, refererUrl = null) => {
    if (!monitorState.page) {
        throw new Error('Browser page not initialized');
    }
    
    // Calculate referer: if showpage parameter exists, use previous page; otherwise use the same URL
    let referer = refererUrl || url;
    if (url.includes('showpage')) {
        const pageMatch = url.match(/showpage=(\d+)/);
        if (pageMatch) {
            const currentPage = parseInt(pageMatch[1]);
            if (currentPage > 1) {
                referer = url.replace(/showpage=\d+/, `showpage=${currentPage - 1}`);
            } else {
                referer = url.replace(/[?&]showpage=\d+/, '');
            }
        }
    }
    
    // Use browser's fetch API which automatically uses cookies and browser's network stack
    const html = await monitorState.page.evaluate(async (url, referer) => {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': referer,
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1'
            },
            credentials: 'include'
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.text();
    }, url, referer);
    
    return html;
}

// Extract watch URLs from HTML content
const extractWatchUrlsFromHtml = (html, baseUrl) => {
    const $ = cheerio.load(html);
    const watchUrls = [];
    
    // Method 1: Try to extract URLs from JSON-LD structured data (most reliable)
    try {
        const jsonLdScripts = $('script[type="application/ld+json"]');
        
        jsonLdScripts.each((index, script) => {
            try {
                const scriptContent = $(script).html();
                if (scriptContent) {
                    const jsonData = JSON.parse(scriptContent);
                    const graph = jsonData['@graph'] || (Array.isArray(jsonData) ? jsonData : [jsonData]);
                    
                    graph.forEach((item) => {
                        // Extract from AggregateOffer (listings page)
                        if (item['@type'] === 'AggregateOffer' && item.offers && Array.isArray(item.offers)) {
                            item.offers.forEach((offer) => {
                                if (offer['@type'] === 'Offer' && offer.url) {
                                    const url = offer.url.split('#')[0];
                                    if (url.includes('.htm') && !watchUrls.includes(url)) {
                                        watchUrls.push(url);
                                    }
                                }
                            });
                        }
                        
                        // Extract from ItemList (listings page)
                        if (item['@type'] === 'ItemList' && item.itemListElement && Array.isArray(item.itemListElement)) {
                            item.itemListElement.forEach((listItem) => {
                                if (listItem.item && listItem.item.url) {
                                    const url = listItem.item.url.split('#')[0];
                                    if (url.includes('.htm') && !watchUrls.includes(url)) {
                                        watchUrls.push(url);
                                    }
                                } else if (listItem.url) {
                                    const url = listItem.url.split('#')[0];
                                    if (url.includes('.htm') && !watchUrls.includes(url)) {
                                        watchUrls.push(url);
                                    }
                                }
                            });
                        }
                        
                        // Extract from Product (individual product page)
                        if (item['@type'] === 'Product' && item.url) {
                            const url = item.url.split('#')[0];
                            if (url.includes('.htm') && !watchUrls.includes(url)) {
                                watchUrls.push(url);
                            }
                        }
                        
                        // Extract from any item with url property
                        if (item.url && typeof item.url === 'string') {
                            const url = item.url.split('#')[0];
                            if (url.includes('.htm') && !watchUrls.includes(url)) {
                                watchUrls.push(url);
                            }
                        }
                    });
                }
            } catch (parseError) {
                // Skip invalid JSON, continue to next script tag
            }
        });
        
        if (watchUrls.length > 0) {
            return watchUrls;
        }
    } catch (error) {
        // Fall back to DOM parsing
    }
    
    // Method 2: Fall back to DOM parsing if JSON-LD extraction didn't work
    const articleItems = $('.article-item-container, .js-article-item-container');
    
    articleItems.each((index, item) => {
        try {
            const $item = $(item);
            let linkElement = null;
            
            // Try multiple selectors to find the watch link
            linkElement = $item.find('a.wt-listing-item-link, a.listing-item-link').first();
            
            // If not found, try any anchor with href containing .htm
            if (linkElement.length === 0) {
                linkElement = $item.find('a[href*=".htm"]').first();
            }
            
            // If still not found, try any anchor with href
            if (linkElement.length === 0) {
                $item.find('a[href]').each((i, link) => {
                    const href = $(link).attr('href');
                    if (href && !href.startsWith('#') && href.includes('.htm')) {
                        linkElement = $(link);
                        return false; // break
                    }
                });
            }
            
            if (linkElement.length > 0) {
                let href = linkElement.attr('href');
                if (href) {
                    // Ensure full URL (use domain from baseUrl, not hardcoded)
                    if (!href.startsWith('http')) {
                        const urlObj = new URL(baseUrl);
                        if (href.startsWith('index.htm')) {
                            href = urlObj.origin + '/search/' + href;
                        } else if (href.startsWith('/')) {
                            href = urlObj.origin + href;
                        } else {
                            const basePath = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/'));
                            href = urlObj.origin + basePath + '/' + href;
                        }
                    }
                    // Normalize URL (remove fragments)
                    href = href.split('#')[0];
                    // Only add if it's a watch detail page (contains .htm) and not already in list
                    if (href.includes('.htm') && !watchUrls.includes(href)) {
                        watchUrls.push(href);
                    }
                }
            }
        } catch (error) {
            // Skip invalid items
        }
    });
    
    return watchUrls;
}

// Extract all pagination URLs from HTML
const extractAllPaginationUrls = (html, currentUrl) => {
    try {
        const $ = cheerio.load(html);
        const paginationUrls = [];
        
        // Extract current page number from URL
        const currentUrlObj = new URL(currentUrl);
        const currentPageParam = currentUrlObj.searchParams.get('showpage');
        const currentPageNum = currentPageParam ? parseInt(currentPageParam) : 1;
        
        // Look for the pagination list
        let pagination = $('ul.list-unstyled.d-flex.gap-1').first();
        if (pagination.length === 0) {
            pagination = $('ul[class*="pagination"], .pagination, nav[aria-label*="pagination"]').first();
        }
        
        if (pagination.length === 0) {
            return paginationUrls;
        }
        
        // Extract all page number links
        pagination.find('a[href*="showpage"], a[href*="page"]').each((i, link) => {
            const $link = $(link);
            if (!$link.hasClass('disabled') && $link.attr('href')) {
                let linkUrl = $link.attr('href');
                
                // Handle relative URLs
                if (!linkUrl.startsWith('http')) {
                    const urlObj = new URL(currentUrl);
                    if (linkUrl.startsWith('index.htm')) {
                        linkUrl = urlObj.origin + '/search/' + linkUrl;
                    } else if (linkUrl.startsWith('/')) {
                        linkUrl = urlObj.origin + linkUrl;
                    } else {
                        const basePath = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/'));
                        linkUrl = urlObj.origin + basePath + '/' + linkUrl;
                    }
                }
                
                try {
                    const linkUrlObj = new URL(linkUrl);
                    const linkPageParam = linkUrlObj.searchParams.get('showpage');
                    const linkPageNum = linkPageParam ? parseInt(linkPageParam) : null;
                    
                    if (linkPageNum && linkPageNum > 0) {
                        if (!paginationUrls.find(u => u.pageNum === linkPageNum)) {
                            paginationUrls.push({ pageNum: linkPageNum, url: linkUrl });
                        }
                    }
                } catch (e) {
                    // Skip invalid URLs
                }
            }
        });
        
        // Sort by page number
        paginationUrls.sort((a, b) => a.pageNum - b.pageNum);
        
        return paginationUrls;
    } catch (error) {
        return [];
    }
}

// Check if there's a next page available from HTML
const hasNextPageFromHtml = (html, currentUrl) => {
    try {
        const $ = cheerio.load(html);
        
        // Extract current page number from URL
        const currentUrlObj = new URL(currentUrl);
        const currentPageParam = currentUrlObj.searchParams.get('showpage');
        const currentPageNum = currentPageParam ? parseInt(currentPageParam) : 1;
        
        // Look for the pagination list
        let pagination = $('ul.list-unstyled.d-flex.gap-1').first();
        if (pagination.length === 0) {
            pagination = $('ul[class*="pagination"], .pagination, nav[aria-label*="pagination"]').first();
        }
        
        if (pagination.length === 0) {
            return { hasNext: false, nextUrl: null, nextPageNum: null };
        }
        
        // Find the forward/next button with i-forward icon
        const forwardButton = pagination.find('a i.i-forward').parent('a');
        if (forwardButton.length > 0) {
            const href = forwardButton.attr('href');
            const isDisabled = forwardButton.hasClass('disabled');
            
            if (href && !isDisabled) {
                let nextUrl = href;
                // Handle relative URLs (use domain from currentUrl, not hardcoded)
                if (!nextUrl.startsWith('http')) {
                    const urlObj = new URL(currentUrl);
                    if (nextUrl.startsWith('index.htm')) {
                        nextUrl = urlObj.origin + '/search/' + nextUrl;
                    } else if (nextUrl.startsWith('/')) {
                        nextUrl = urlObj.origin + nextUrl;
                    } else {
                        const basePath = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/'));
                        nextUrl = urlObj.origin + basePath + '/' + nextUrl;
                    }
                }
                
                // Extract page number from next URL
                const nextUrlObj = new URL(nextUrl);
                const nextPageParam = nextUrlObj.searchParams.get('showpage');
                const nextPageNum = nextPageParam ? parseInt(nextPageParam) : (currentPageNum + 1);
                
                if (nextPageNum > currentPageNum) {
                    return { hasNext: true, nextUrl: nextUrl, nextPageNum: nextPageNum };
                }
            }
        }
        
        // Check for page number links that have showpage parameter
        let nextPageNum = null;
        let nextUrl = null;
        
        pagination.find('a[href*="showpage"]').each((i, link) => {
            const $link = $(link);
            if (!$link.hasClass('disabled')) {
                let linkUrl = $link.attr('href');
                if (linkUrl) {
                    // Handle relative URLs (use domain from currentUrl, not hardcoded)
                    if (!linkUrl.startsWith('http')) {
                        const urlObj = new URL(currentUrl);
                        if (linkUrl.startsWith('index.htm')) {
                            linkUrl = urlObj.origin + '/search/' + linkUrl;
                        } else if (linkUrl.startsWith('/')) {
                            linkUrl = urlObj.origin + linkUrl;
                        }
                    }
                    
                    try {
                        const linkUrlObj = new URL(linkUrl);
                        const linkPageParam = linkUrlObj.searchParams.get('showpage');
                        const linkPageNum = linkPageParam ? parseInt(linkPageParam) : null;
                        
                        if (linkPageNum && linkPageNum > currentPageNum) {
                            if (!nextPageNum || linkPageNum < nextPageNum) {
                                nextPageNum = linkPageNum;
                                nextUrl = linkUrl;
                            }
                        }
                    } catch (e) {
                        // Skip invalid URLs
                    }
                }
            }
        });
        
        if (nextUrl && nextPageNum && nextPageNum > currentPageNum) {
            return { hasNext: true, nextUrl: nextUrl, nextPageNum: nextPageNum };
        }
        
        return { hasNext: false, nextUrl: null, nextPageNum: null };
    } catch (error) {
        return { hasNext: false, nextUrl: null, nextPageNum: null };
    }
}

// Check if there's a next page available (using Puppeteer - kept for backward compatibility)
const hasNextPage = async (currentUrl) => {
    try {
        const nextPageInfo = await monitorState.page.evaluate((currentUrl) => {
            // Extract current page number from URL
            const currentUrlObj = new URL(currentUrl);
            const currentPageParam = currentUrlObj.searchParams.get('showpage');
            const currentPageNum = currentPageParam ? parseInt(currentPageParam) : 1;

            // Look for the pagination list
            const paginationList = document.querySelector('ul.list-unstyled.d-flex.gap-1');
            if (!paginationList) {
                // Try alternative selector
                const altPagination = document.querySelector('ul[class*="pagination"], .pagination, nav[aria-label*="pagination"]');
                if (!altPagination) return { hasNext: false, nextUrl: null, nextPageNum: null };
            }

            const pagination = paginationList || document.querySelector('ul[class*="pagination"], .pagination, nav[aria-label*="pagination"]');
            if (!pagination) return { hasNext: false, nextUrl: null, nextPageNum: null };

            // Find the forward/next button with i-forward icon
            const forwardButton = pagination.querySelector('a i.i-forward')?.closest('a');
            if (forwardButton && forwardButton.href && !forwardButton.classList.contains('disabled')) {
                let nextUrl = forwardButton.href;
                // Handle relative URLs
                if (nextUrl && !nextUrl.startsWith('http')) {
                    if (nextUrl.startsWith('index.htm')) {
                        nextUrl = window.location.origin + '/search/' + nextUrl;
                    } else if (nextUrl.startsWith('/')) {
                        nextUrl = window.location.origin + nextUrl;
                    } else {
                        const currentPath = window.location.pathname;
                        const basePath = currentPath.substring(0, currentPath.lastIndexOf('/'));
                        nextUrl = window.location.origin + basePath + '/' + nextUrl;
                    }
                }
                // Extract page number from next URL
                const nextUrlObj = new URL(nextUrl);
                const nextPageParam = nextUrlObj.searchParams.get('showpage');
                const nextPageNum = nextPageParam ? parseInt(nextPageParam) : (currentPageNum + 1);
                
                if (nextPageNum > currentPageNum) {
                    return { hasNext: true, nextUrl: nextUrl, nextPageNum: nextPageNum };
                }
            }

            // Check for page number links that have showpage parameter
            const pageLinks = pagination.querySelectorAll('a[href*="showpage"]');
            let nextPageNum = null;
            let nextUrl = null;
            
            for (const link of pageLinks) {
                if (!link.classList.contains('disabled') && link.href) {
                    let linkUrl = link.href;
                    // Handle relative URLs
                    if (linkUrl && !linkUrl.startsWith('http')) {
                        if (linkUrl.startsWith('index.htm')) {
                            linkUrl = window.location.origin + '/search/' + linkUrl;
                        } else if (linkUrl.startsWith('/')) {
                            linkUrl = window.location.origin + linkUrl;
                        }
                    }
                    
                    try {
                        const linkUrlObj = new URL(linkUrl);
                        const linkPageParam = linkUrlObj.searchParams.get('showpage');
                        const linkPageNum = linkPageParam ? parseInt(linkPageParam) : null;
                        
                        if (linkPageNum && linkPageNum > currentPageNum) {
                            if (!nextPageNum || linkPageNum < nextPageNum) {
                                nextPageNum = linkPageNum;
                                nextUrl = linkUrl;
                            }
                        }
                    } catch (e) {
                        // Skip invalid URLs
                        continue;
                    }
                }
            }

            if (nextUrl && nextPageNum && nextPageNum > currentPageNum) {
                return { hasNext: true, nextUrl: nextUrl, nextPageNum: nextPageNum };
            }

            return { hasNext: false, nextUrl: null, nextPageNum: null };
        }, currentUrl);

        return nextPageInfo;
    } catch (error) {
        return { hasNext: false, nextUrl: null, nextPageNum: null };
    }
}

// Scrape watch URLs from a single page
const scrapeSinglePage = async () => {
    try {
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Wait for Cloudflare challenge to complete
        let cloudflareCheckCount = 0;
        const maxCloudflareChecks = 10;
        
        while (cloudflareCheckCount < maxCloudflareChecks) {
            const isCloudflareChallenge = await monitorState.page.evaluate(() => {
                return document.title.includes('Just a moment') ||
                    document.querySelector('cf-challenge') !== null ||
                    document.querySelector('.cf-browser-verification') !== null ||
                    document.querySelector('#challenge-form') !== null;
            });

            if (isCloudflareChallenge) {
                await new Promise(resolve => setTimeout(resolve, 5000));
                cloudflareCheckCount++;
            } else {
                break;
            }
        }

        await monitorState.page.waitForSelector('.article-item-container, .js-article-item-container', { timeout: 60000 });

        // Extract only watch URLs from the page
        const watchUrls = await monitorState.page.evaluate(() => {
            const items = document.querySelectorAll('.article-item-container, .js-article-item-container');
            const urls = [];

            items.forEach((item) => {
                try {
                    let linkElement = item.querySelector('a.wt-listing-item-link, a.listing-item-link');
                    
                    if (!linkElement) {
                        linkElement = item.querySelector('a[href*=".htm"]');
                    }
                    
                    if (!linkElement) {
                        const allLinks = item.querySelectorAll('a[href]');
                        for (const link of allLinks) {
                            const href = link.getAttribute('href');
                            if (href && !href.startsWith('#') && href.includes('.htm')) {
                                linkElement = link;
                                break;
                            }
                        }
                    }
                    
                    if (linkElement && linkElement.href) {
                        const link = linkElement.href;
                        let fullUrl = link.startsWith('http') ? link : window.location.origin + link;
                        fullUrl = fullUrl.split('#')[0];
                        if (fullUrl.includes('.htm') && !urls.includes(fullUrl)) {
                            urls.push(fullUrl);
                        }
                    }
                } catch (error) {
                    // Skip invalid items
                }
            });

            return urls;
        });

        return watchUrls;
    } catch (error) {
        console.error('Error scraping page:', error.message);
        return [];
    }
}

// Scrape all pages with pagination support using browser (fallback when HTTP fails)
const scrapeWatchListingsWithBrowser = async () => {
    console.log('Scraping watch listings with pagination support (using browser)...');

    // Initialize browser if not already initialized
    if (!monitorState.browser || !monitorState.page) {
        console.log('Initializing browser for listing page scraping...');
        await initBrowser();
    }

    let allWatchUrls = [];
    let visitedUrls = new Set();
    const maxPages = 20;

    try {
        await monitorState.page.goto(CONFIG.PARENT_URL, {
            waitUntil: 'networkidle2',
            timeout: 90000
        });

        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Check and wait for Cloudflare challenge
        let cloudflareCheckCount = 0;
        const maxCloudflareChecks = 10;
        
        while (cloudflareCheckCount < maxCloudflareChecks) {
            const isCloudflareChallenge = await monitorState.page.evaluate(() => {
                return document.title.includes('Just a moment') ||
                    document.querySelector('cf-challenge') !== null ||
                    document.querySelector('.cf-browser-verification') !== null ||
                    document.querySelector('#challenge-form') !== null;
            });

            if (isCloudflareChallenge) {
                console.log(`Cloudflare challenge detected, waiting... (${cloudflareCheckCount + 1}/${maxCloudflareChecks})`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                cloudflareCheckCount++;
            } else {
                break;
            }
        }

        let currentPage = 1;
        let hasMorePages = true;
        let currentUrl = monitorState.page.url();

        while (hasMorePages && currentPage <= maxPages) {
            console.log(`\nProcessing page ${currentPage}...`);
            
            if (visitedUrls.has(currentUrl)) {
                console.log(`⚠️  Already visited this URL, stopping pagination.`);
                break;
            }
            visitedUrls.add(currentUrl);
            
            let nextPageInfo = null;
            try {
                const pageWatchUrls = await scrapeSinglePage();
                if (pageWatchUrls && pageWatchUrls.length > 0) {
                    pageWatchUrls.forEach(url => {
                        if (!allWatchUrls.includes(url)) {
                            allWatchUrls.push(url);
                        }
                    });
                    console.log(`✅ Found ${pageWatchUrls.length} watch URLs on this page (${allWatchUrls.length} total unique URLs)`);
                }

                nextPageInfo = await hasNextPage(currentUrl);
                
                if (nextPageInfo.hasNext && nextPageInfo.nextUrl && nextPageInfo.nextPageNum) {
                    if (visitedUrls.has(nextPageInfo.nextUrl)) {
                        console.log(`⚠️  Next page URL already visited, stopping pagination.`);
                        hasMorePages = false;
                        break;
                    }
                    
                    console.log(`Next page found: Page ${nextPageInfo.nextPageNum} - ${nextPageInfo.nextUrl}`);
                    
                    await monitorState.page.goto(nextPageInfo.nextUrl, {
                        waitUntil: 'networkidle2',
                        timeout: 90000
                    });
                    
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    currentUrl = monitorState.page.url();
                    currentPage++;
                } else {
                    hasMorePages = false;
                    console.log('No more pages to scrape.');
                }
            } catch (pageError) {
                console.error(`Error scraping page ${currentPage}: ${pageError.message}`);
                hasMorePages = false;
                break;
            }
        }

        allWatchUrls = [...new Set(allWatchUrls)];
        console.log(`\n✅ Total watch URLs found across ${currentPage} pages: ${allWatchUrls.length}`);
        return allWatchUrls;

    } catch (error) {
        console.error('Error scraping listings with browser:', error.message);
        allWatchUrls = [...new Set(allWatchUrls)];
        return allWatchUrls;
    }
}

// Scrape all pages with pagination support using HTTP requests (with browser fallback)
const scrapeWatchListings = async () => {
    console.log('Scraping watch listings with pagination support (trying HTTP requests first)...');

    let allWatchUrls = [];
    let visitedUrls = new Set();
    const maxPages = 20; // Safety limit to prevent infinite loops (127 watches should be ~3 pages)

    try {
        let currentPage = 1;
        let hasMorePages = true;
        let currentUrl = CONFIG.PARENT_URL;
        let previousUrl = null;
        let cloudflareDetected = false;
        let allPaginationUrls = []; // Store all pagination URLs found on first page

        // First, fetch the first page to extract all pagination URLs
        try {
            console.log('\n📄 Fetching first page to extract all pagination URLs...');
            const firstPageHtml = await fetchPageHtml(currentUrl, null);
            allPaginationUrls = extractAllPaginationUrls(firstPageHtml, currentUrl);
            
            // Add the first page if not in pagination URLs
            if (allPaginationUrls.length === 0 || allPaginationUrls[0].pageNum !== 1) {
                allPaginationUrls.unshift({ pageNum: 1, url: currentUrl });
            }
            
            console.log(`\n📋 Found ${allPaginationUrls.length} total page(s) to scrape`);
            if (allPaginationUrls.length > 0) {
                console.log('Pagination URLs:');
                allPaginationUrls.forEach((p, idx) => {
                    console.log(`  Page ${p.pageNum}: ${p.url}`);
                });
            }
        } catch (error) {
            console.log('⚠️  Could not extract all pagination URLs, will use sequential pagination:', error.message);
        }

        while (hasMorePages && currentPage <= maxPages) {
            console.log(`\nProcessing page ${currentPage}...`);
            console.log(`URL: ${currentUrl}`);
            
            // Check if we've already visited this URL
            if (visitedUrls.has(currentUrl)) {
                console.log(`⚠️  Already visited this URL, stopping pagination to prevent loop.`);
                break;
            }
            visitedUrls.add(currentUrl);
            
            let nextPageInfo = null;
            try {
                // Fetch page HTML via HTTP request (pass previous URL as referer)
                const html = await fetchPageHtml(currentUrl, previousUrl);
                
                // Extract watch URLs from HTML
                const pageWatchUrls = extractWatchUrlsFromHtml(html, currentUrl);
                
                if (pageWatchUrls && pageWatchUrls.length > 0) {
                    // Deduplicate URLs before adding
                    pageWatchUrls.forEach(url => {
                        if (!allWatchUrls.includes(url)) {
                            allWatchUrls.push(url);
                        }
                    });
                    console.log(`✅ Found ${pageWatchUrls.length} watch URLs on this page (${allWatchUrls.length} total unique URLs)`);
                } else {
                    console.log(`⚠️  No watch URLs found on page ${currentPage}`);
                }

                // If we have all pagination URLs, use them; otherwise check for next page
                if (allPaginationUrls.length > 0 && currentPage < allPaginationUrls.length) {
                    // Use pre-extracted pagination URLs
                    const nextPageData = allPaginationUrls.find(p => p.pageNum === currentPage + 1);
                    if (nextPageData) {
                        nextPageInfo = { hasNext: true, nextUrl: nextPageData.url, nextPageNum: nextPageData.pageNum };
                    } else {
                        nextPageInfo = { hasNext: false, nextUrl: null, nextPageNum: null };
                    }
                } else {
                    // Fallback: Check if there's a next page from HTML
                    nextPageInfo = hasNextPageFromHtml(html, currentUrl);
                }
                
                if (nextPageInfo.hasNext && nextPageInfo.nextUrl && nextPageInfo.nextPageNum) {
                    // Check if we've already visited the next URL
                    if (visitedUrls.has(nextPageInfo.nextUrl)) {
                        console.log(`⚠️  Next page URL already visited, stopping pagination.`);
                        hasMorePages = false;
                        break;
                    }
                    
                    console.log(`Next page found: Page ${nextPageInfo.nextPageNum} - ${nextPageInfo.nextUrl}`);
                    previousUrl = currentUrl;
                    currentUrl = nextPageInfo.nextUrl;
                    currentPage++;
                    
                    // Small delay between requests to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 2000));
                } else {
                    hasMorePages = false;
                    console.log('No more pages to scrape.');
                }
            } catch (pageError) {
                console.error(`Error scraping page ${currentPage}: ${pageError.message}`);
                
                // If 403 Forbidden (cookies expired), try to refresh cookies and retry once
                if (pageError.message.includes('403 Forbidden') || pageError.message.includes('refresh cookies')) {
                    console.log('⚠️  Cookies may have expired, refreshing cookies and retrying...');
                    try {
                        await getCookiesFromBrowser();
                        // Retry the same page once
                        const html = await fetchPageHtml(currentUrl, previousUrl);
                        const pageWatchUrls = extractWatchUrlsFromHtml(html, currentUrl);
                        if (pageWatchUrls && pageWatchUrls.length > 0) {
                            pageWatchUrls.forEach(url => {
                                if (!allWatchUrls.includes(url)) {
                                    allWatchUrls.push(url);
                                }
                            });
                            console.log(`✅ Found ${pageWatchUrls.length} watch URLs after refreshing cookies`);
                        }
                        nextPageInfo = hasNextPageFromHtml(html, currentUrl);
                        // Continue with pagination
                        if (nextPageInfo.hasNext && nextPageInfo.nextUrl && nextPageInfo.nextPageNum) {
                            if (!visitedUrls.has(nextPageInfo.nextUrl)) {
                                previousUrl = currentUrl;
                                currentUrl = nextPageInfo.nextUrl;
                                currentPage++;
                                await new Promise(resolve => setTimeout(resolve, 2000));
                                continue;
                            }
                        }
                    } catch (retryError) {
                        console.log('⚠️  Retry failed, switching to browser-based scraping...');
                        cloudflareDetected = true;
                        break;
                    }
                }
                
                // If other errors, try to continue to next page if we have pagination info
                if (nextPageInfo && nextPageInfo.hasNext && nextPageInfo.nextUrl && !visitedUrls.has(nextPageInfo.nextUrl)) {
                    previousUrl = currentUrl;
                    currentUrl = nextPageInfo.nextUrl;
                    currentPage++;
                    await new Promise(resolve => setTimeout(resolve, 2000));
                } else {
                    hasMorePages = false;
                    break;
                }
            }
        }

        // If HTTP requests failed, use browser fallback
        if (cloudflareDetected) {
            console.log('\n🔄 Falling back to browser-based scraping...');
            const browserUrls = await scrapeWatchListingsWithBrowser();
            // Merge with any URLs we already collected
            browserUrls.forEach(url => {
                if (!allWatchUrls.includes(url)) {
                    allWatchUrls.push(url);
                }
            });
        }

        if (currentPage > maxPages && !cloudflareDetected) {
            console.log(`⚠️  Reached maximum page limit (${maxPages}), stopping.`);
        }

        // Deduplicate final list
        allWatchUrls = [...new Set(allWatchUrls)];
        console.log(`\n✅ Total watch URLs found: ${allWatchUrls.length}`);
        return allWatchUrls;

    } catch (error) {
        console.error('Error scraping listings:', error.message);
        // If HTTP completely fails, try browser
        if (error.message.includes('403 Forbidden') || error.message.includes('refresh cookies')) {
            console.log('\n🔄 HTTP requests failed, falling back to browser-based scraping...');
            return await scrapeWatchListingsWithBrowser();
        }
        // Return collected URLs even if there was an error
        allWatchUrls = [...new Set(allWatchUrls)];
        console.log(`Returning ${allWatchUrls.length} collected URLs despite error.`);
        return allWatchUrls;
    }
}

// Fetch watch detail page HTML via HTTP request (using browser fetch)
const fetchWatchDetailHtml = async (watchUrl, refererUrl = null) => {
    if (!monitorState.page) {
        throw new Error('Browser page not initialized');
    }
    
    const referer = refererUrl || CONFIG.PARENT_URL;
    
    const html = await monitorState.page.evaluate(async (url, referer) => {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': referer,
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1'
            },
            credentials: 'include'
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.text();
    }, watchUrl, referer);
    
    return html;
}

// Helper function to clean and extract base model name
const cleanModelName = (modelString) => {
    if (!modelString || typeof modelString !== 'string') {
        return '';
    }
    
    // Remove leading/trailing whitespace
    let model = modelString.trim();
    
    // If model contains "|", take only the first part (before the first pipe)
    // Example: "Royal Oak Quartz | 56271ST | Blue Dial" -> "Royal Oak Quartz"
    if (model.includes('|')) {
        model = model.split('|')[0].trim();
    }
    
    // Remove reference numbers (patterns like "56271ST", "116619LB", "WSSA0030", etc.)
    // These are typically 5-6 digits followed by 1-3 letters, or alphanumeric codes
    model = model.replace(/\b\d{5,6}[A-Z]{1,3}\b/g, '').trim();
    model = model.replace(/\b[A-Z]{2,}\d{4,}\b/g, '').trim(); // Patterns like "WSSA0030"
    
    // Remove movement types that appear at the end (these are not part of model name)
    // English: Quartz, Automatic, Manual, Mechanical
    // French: Quartz, Automatique, Manuel, Mécanique
    const movementTypes = ['Quartz', 'Automatic', 'Manual', 'Mechanical', 
                           'Quartz', 'Automatique', 'Manuel', 'Mécanique'];
    for (const movement of movementTypes) {
        const regex = new RegExp(`\\b${movement}\\s*$`, 'i');
        model = model.replace(regex, '').trim();
    }
    
    // Remove dial colors that appear at the end
    // English: Blue Dial, Black Dial, White Dial, etc.
    // French: Cadran Bleu, Cadran Noir, Cadran Blanc, etc. (or just "Bleu", "Noir", etc.)
    const dialColors = [
        'Blue Dial', 'Black Dial', 'White Dial', 'Green Dial', 'Rhodium Dial',
        'Silver Dial', 'Grey Dial', 'Gray Dial', 'Pink Dial', 'Red Dial',
        'Cadran Bleu', 'Cadran Noir', 'Cadran Blanc', 'Cadran Vert', 'Cadran Rhodium',
        'Cadran Argent', 'Cadran Gris', 'Cadran Rose', 'Cadran Rouge',
        'Bleu', 'Noir', 'Blanc', 'Vert', 'Gris', 'Rose', 'Rouge' // Just colors
    ];
    for (const color of dialColors) {
        const regex = new RegExp(`\\b${color}\\s*$`, 'i');
        model = model.replace(regex, '').trim();
    }
    
    // Remove condition descriptions at the end
    // English: Great Condition, Mint Condition, Very Good, Excellent, Good Condition, Fair Condition, Unworn, New
    // French: Très bon état, État neuf, Très bon, Excellent, Bon état, Correct, Non porté, Neuf
    const conditions = [
        'Great Condition', 'Mint Condition', 'Very Good', 'Excellent',
        'Good Condition', 'Fair Condition', 'Unworn', 'New',
        'Très bon état', 'État neuf', 'Très bon', 'Excellent',
        'Bon état', 'Correct', 'Non porté', 'Neuf'
    ];
    for (const condition of conditions) {
        const regex = new RegExp(`\\b${condition}\\s*$`, 'i');
        model = model.replace(regex, '').trim();
    }
    
    // Remove other descriptive words that shouldn't be part of model name
    // English: Box, Papers, Original, Certified, Pre-Owned, With Box, With Papers, Box & Papers
    // French: Boîte, Papiers, Original, Certifié, D'occasion, Avec boîte, Avec papiers, Boîte et papiers
    const otherDescriptive = [
        'Box', 'Papers', 'Original', 'Certified', 'Pre-Owned',
        'With Box', 'With Papers', 'Box & Papers',
        'Boîte', 'Papiers', 'Original', 'Certifié', 'D\'occasion',
        'Avec boîte', 'Avec papiers', 'Boîte et papiers'
    ];
    for (const word of otherDescriptive) {
        const regex = new RegExp(`\\b${word}\\s*$`, 'i');
        model = model.replace(regex, '').trim();
    }
    
    // Remove year patterns at the end (like "2025", "2024", etc.)
    model = model.replace(/\b(19|20)\d{2}\s*$/, '').trim();
    
    // Remove any remaining multiple spaces
    model = model.replace(/\s+/g, ' ').trim();
    
    return model;
};

// Extract watch details from HTML using cheerio
const extractWatchDetailsFromHtml = (html, watchUrl) => {
    const $ = cheerio.load(html);
    const result = {
        brand: '',
        model: '',
        referenceNumber: '',
        year: null,
        condition: 'unworn', // Default: unworn if not found
        gender: '',
        location: '',
        price: 0,
        currency: 'USD',
        originalBox: false,
        originalPaper: false,
        images: [],
        watchUrl: watchUrl
    };

    // Method 1: Try to extract from JSON-LD structured data (most reliable)
    try {
        const jsonLdScripts = $('script[type="application/ld+json"]');
        
        jsonLdScripts.each((index, script) => {
            try {
                const scriptContent = $(script).html();
                if (scriptContent) {
                    const jsonData = JSON.parse(scriptContent);
                    
                    // Handle both single object and @graph array
                    const graph = jsonData['@graph'] || (Array.isArray(jsonData) ? jsonData : [jsonData]);
                    
                    graph.forEach((item) => {
                        if (item['@type'] === 'Product') {
                            // Extract images from JSON-LD
                            if (item.image && Array.isArray(item.image)) {
                                item.image.forEach((imgObj) => {
                                    if (imgObj['@type'] === 'ImageObject' && imgObj.contentUrl) {
                                        // Normalize image URL - convert ExtraLarge to Square420
                                        let imgUrl = imgObj.contentUrl;
                                        // Replace ExtraLarge.jpg with Square420.jpg for consistency
                                        imgUrl = imgUrl.replace(/ExtraLarge\.(jpg|jpeg|png|webp)$/i, 'Square420.$1');
                                        // If no extension, add .jpg
                                        if (!/\.(jpg|jpeg|png|webp)$/i.test(imgUrl)) {
                                            imgUrl = imgUrl + '.jpg';
                                        }
                                        if (imgUrl && !result.images.includes(imgUrl)) {
                                            result.images.push(imgUrl);
                                        }
                                    }
                                });
                            }
                            
                            // Extract offer details (price, currency) from JSON-LD
                            if (item.offers && item.offers['@type'] === 'Offer') {
                                const offer = item.offers;
                                
                                // Extract price
                                if (offer.price) {
                                    result.price = typeof offer.price === 'string' 
                                        ? parseInt(offer.price.replace(/,/g, '')) 
                                        : parseInt(offer.price);
                                }
                                
                                // Extract currency
                                if (offer.priceCurrency) {
                                    result.currency = offer.priceCurrency;
                                }
                            }
                            
                            // Extract box and papers from description or name (supporting both English and French)
                            if (item.description) {
                                const descLower = item.description.toLowerCase();
                                
                                // Check for "without" patterns FIRST to avoid false positives
                                // Check for box without
                                if (descLower.includes('without box') || descLower.includes('sans coffret') ||
                                    descLower.includes('sans boîte') || descLower.includes('sans étui') ||
                                    descLower.includes('no box') || descLower.includes('pas de boîte')) {
                                    result.originalBox = false;
                                }
                                // Check for papers without
                                if (descLower.includes('without paper') || descLower.includes('without papers') ||
                                    descLower.includes('sans papiers') || descLower.includes('sans certificat') ||
                                    descLower.includes('sans carte') || descLower.includes('no paper') ||
                                    descLower.includes('no papers') || descLower.includes('pas de papiers')) {
                                    result.originalPaper = false;
                                }
                                
                                // Then check for positive matches (only if not already set to false)
                                // English: original box, box | French: boîte d'origine, boîte originale, boîte, étui
                                if (result.originalBox !== false) {
                                    if (descLower.includes('with original box') || descLower.includes('original box') ||
                                        descLower.includes('with box') || descLower.includes('boîte d\'origine') ||
                                        descLower.includes('boîte originale') || descLower.includes('avec coffret') ||
                                        descLower.includes('avec boîte') || descLower.includes('coffret d\'origine')) {
                                        result.originalBox = true;
                                    } else if (descLower.includes('box') || descLower.includes('boîte') || descLower.includes('étui')) {
                                        result.originalBox = true;
                                    }
                                }
                                
                                // English: original paper, paper, certificate, card
                                // French: papier d'origine, papiers d'origine, papier, papiers, certificat, carte
                                if (result.originalPaper !== false) {
                                    if (descLower.includes('with original paper') || descLower.includes('with original papers') ||
                                        descLower.includes('original paper') || descLower.includes('original papers') ||
                                        descLower.includes('papier d\'origine') || descLower.includes('papiers d\'origine') ||
                                        descLower.includes('avec papiers') || descLower.includes('certificat d\'origine') ||
                                        descLower.includes('carte d\'origine')) {
                                        result.originalPaper = true;
                                    } else if (descLower.includes('paper') || descLower.includes('papers') ||
                                              descLower.includes('papier') || descLower.includes('papiers') ||
                                              descLower.includes('certificate') || descLower.includes('certificat') ||
                                              descLower.includes('card') || descLower.includes('carte')) {
                                        result.originalPaper = true;
                                    }
                                }
                            }
                            
                            // Also check name for box/paper info (supporting both English and French)
                            if (item.name) {
                                const nameLower = item.name.toLowerCase();
                                
                                // Check for "without" patterns FIRST
                                if (nameLower.includes('without box') || nameLower.includes('sans boîte') ||
                                    nameLower.includes('no box') || nameLower.includes('pas de boîte')) {
                                    result.originalBox = false;
                                }
                                if (nameLower.includes('without paper') || nameLower.includes('without papers') ||
                                    nameLower.includes('sans papiers') || nameLower.includes('no paper') ||
                                    nameLower.includes('no papers') || nameLower.includes('pas de papiers')) {
                                    result.originalPaper = false;
                                }
                                
                                // Then check for positive matches
                                // English: box | French: boîte, étui
                                if (result.originalBox !== false) {
                                    if (nameLower.includes('with box') || nameLower.includes('with original box') ||
                                        nameLower.includes('boîte d\'origine') || nameLower.includes('avec boîte')) {
                                        result.originalBox = true;
                                    } else if (nameLower.includes('box') || nameLower.includes('boîte') || nameLower.includes('étui')) {
                                        result.originalBox = true;
                                    }
                                }
                                
                                // English: paper | French: papier, papiers
                                if (result.originalPaper !== false) {
                                    if (nameLower.includes('with paper') || nameLower.includes('with papers') ||
                                        nameLower.includes('with original paper') || nameLower.includes('with original papers') ||
                                        nameLower.includes('papiers d\'origine') || nameLower.includes('avec papiers')) {
                                        result.originalPaper = true;
                                    } else if (nameLower.includes('paper') || nameLower.includes('papers') ||
                                              nameLower.includes('papier') || nameLower.includes('papiers')) {
                                        result.originalPaper = true;
                                    }
                                }
                            }
                        }
                    });
                }
            } catch (parseError) {
                // Skip invalid JSON, continue to next script tag
            }
        });
        
        // JSON-LD extraction complete - only extracted: images, price, currency, originalBox, originalPaper
        // Continue to HTML parsing to extract: brand, model, reference, year, condition, location, gender
    } catch (error) {
        // Silent fallback to HTML parsing
    }
    
    // Method 2: Extract price and currency from HTML (if not found in JSON-LD)
    if (result.price === 0 || !result.currency || result.currency === 'USD') {
        // Try to find price element first (more specific)
        let priceElement = $('.js-price-shipping-country').first();
        let priceContainer = null;
        
        if (priceElement.length > 0) {
            // Get the parent container for currency lookup
            priceContainer = priceElement.closest('.wt-detail-page-price');
            if (priceContainer.length === 0) {
                priceContainer = priceElement.parent();
            }
        } else {
            // Fallback to container
            priceContainer = $('.wt-detail-page-price').first();
            priceElement = priceContainer.find('.js-price-shipping-country, [class*="price"]').first();
            if (priceElement.length === 0) {
                priceElement = priceContainer;
            }
        }
        
        if (priceElement.length > 0) {
            // Get all text from the price element (includes nested spans)
            const priceText = priceElement.text().trim();
            // Replace non-breaking spaces (\u00A0) and regular spaces
            const normalizedText = priceText.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ');
            
            // Extract price number (remove currency symbols, spaces, commas, and dots)
            const priceMatch = normalizedText.match(/[\d\s,\.]+/);
            if (priceMatch) {
                const priceStr = priceMatch[0].replace(/\s/g, '').replace(/,/g, '').replace(/\./g, '');
                const priceNum = parseInt(priceStr);
                if (!isNaN(priceNum) && priceNum > 0) {
                    result.price = priceNum;
                }
            }
            
            // Extract currency - first try to find .currency span in container or element
            let currencySpan = null;
            if (priceContainer && priceContainer.length > 0) {
                currencySpan = priceContainer.find('.currency').first();
            }
            if (!currencySpan || currencySpan.length === 0) {
                currencySpan = priceElement.find('.currency').first();
            }
            
            let currencyText = '';
            if (currencySpan && currencySpan.length > 0) {
                currencyText = currencySpan.text().trim();
            } else {
                currencyText = normalizedText;
            }
            
            // Extract currency symbol or code
            const currencyMatch = currencyText.match(/[€$£¥]|EUR|USD|GBP|CHF|JPY|CAD|AUD/);
            if (currencyMatch) {
                const currencySymbol = currencyMatch[0];
                const currencyMap = {
                    '€': 'EUR',
                    '$': 'USD',
                    '£': 'GBP',
                    '¥': 'JPY',
                    'EUR': 'EUR',
                    'USD': 'USD',
                    'GBP': 'GBP',
                    'CHF': 'CHF',
                    'JPY': 'JPY',
                    'CAD': 'CAD',
                    'AUD': 'AUD'
                };
                result.currency = currencyMap[currencySymbol] || result.currency;
            }
        }
    }
    
    // Method 3: Extract images from HTML (if not found in JSON-LD)
    if (result.images.length === 0) {
        // Find all image elements with data-original or src containing chrono24.com/images
        $('img[data-original], img.js-original-image, img[src*="chrono24.com/images"]').each((index, img) => {
            const $img = $(img);
            let imgUrl = $img.attr('data-original') || $img.attr('src');
            
            if (imgUrl && imgUrl.includes('chrono24.com/images')) {
                // Normalize image URL - convert ExtraLarge to Square420
                imgUrl = imgUrl.replace(/ExtraLarge\.(jpg|jpeg|png|webp)$/i, 'Square420.$1');
                // If no extension, add .jpg
                if (!/\.(jpg|jpeg|png|webp)$/i.test(imgUrl)) {
                    imgUrl = imgUrl + '.jpg';
                }
                // Only add if it's a watch image (contains /uhren/ or /images/uhren/)
                if (imgUrl.includes('/uhren/') && !result.images.includes(imgUrl)) {
                    result.images.push(imgUrl);
                }
            }
        });
    }
    
    // Method 4: Extract reference number from URL or title if not found in table
    if (!result.referenceNumber) {
        // Try to extract from URL pattern: ref-18239 or ref-18239-serie
        const urlMatch = watchUrl.match(/ref[-\s]?(\d{4,6})/i);
        if (urlMatch && urlMatch[1]) {
            result.referenceNumber = urlMatch[1];
        } else {
            // Try to extract from title
            const title = $('title').text();
            const titleMatch = title.match(/ref[-\s]?(\d{4,6})/i);
            if (titleMatch && titleMatch[1]) {
                result.referenceNumber = titleMatch[1];
            }
        }
    }
    
    // Method 5: HTML table parsing - always run to extract/replace data from HTML structure
    
    // Extract details from HTML table structure
    // Find the first div with class "js-tab-panel tab-panel" (contains all the data)
    const tabPanels = $('.js-tab-panel.tab-panel');
    let tabPanel = tabPanels.first();
    
    if (tabPanel.length > 0) {
        // Find the first table in the tab panel (contains Basic Info section)
        const firstTable = tabPanel.find('table').first();
        
        if (firstTable.length > 0) {
            // Process all tbody sections in the table
            firstTable.find('tbody').each((tbodyIndex, tbody) => {
                const $tbody = $(tbody);
                
                // Find all rows in this tbody
                $tbody.find('tr').each((index, row) => {
                    const $row = $(row);
                    const cells = $row.find('td');
                    
                    // Skip if not enough cells (need at least 2 for label and value)
                    if (cells.length < 2) {
                        return;
                    }
                    
                    // Get label from first cell (should be in <strong> tag)
                    const $labelCell = cells.eq(0);
                    let label = $labelCell.find('strong').first().text().trim();
                    if (!label) {
                        label = $labelCell.text().trim();
                    }
                    
                    // Skip header rows (those with colspan="2" or containing only headers)
                    if ($labelCell.attr('colspan') === '2' || cells.length === 1) {
                        return;
                    }
                    
                    // Skip if label is empty
                    if (!label) {
                        return;
                    }
                    
                    label = label.toLowerCase();
                    
                    // Helper function to check if label matches English or French
                    const matchesLabel = (englishTerms, frenchTerms) => {
                        const terms = Array.isArray(englishTerms) ? englishTerms : [englishTerms];
                        const french = Array.isArray(frenchTerms) ? frenchTerms : [frenchTerms];
                        return terms.some(term => label.includes(term)) || 
                               french.some(term => label.includes(term));
                    };
                    
                    // Skip section headers (Basic Info, Caliber, Case, Bracelet, Description, etc.)
                    // English: basic info, caliber, case, bracelet, functions, description
                    // French: informations de base, calibre, boîtier, bracelet, fonctions, description
                    if (matchesLabel(['basic info', 'caliber', 'case', 'bracelet', 'functions', 'description'],
                                   ['informations de base', 'informations générales', 'calibre', 'boîtier', 'bracelet', 'fonctions', 'description'])) {
                        return;
                    }
                    
                    // Get value from second cell
                    const $valueCell = cells.eq(1);
                    let value = $valueCell.text().trim();
                    
                    // Extract specific fields based on label (supporting both English and French)
                    if (matchesLabel('brand', 'marque')) {
                        // Brand is usually in an <a> tag
                        const brandLink = $valueCell.find('a').first();
                        if (brandLink.length > 0) {
                            result.brand = brandLink.text().trim();
                        } else if (value) {
                            result.brand = value;
                        }
                    } else if (matchesLabel('model', 'modèle')) {
                        // Model is usually in an <a> tag
                        const modelLink = $valueCell.find('a').first();
                        let modelValue = '';
                        if (modelLink.length > 0) {
                            modelValue = modelLink.text().trim();
                        } else if (value) {
                            modelValue = value;
                        }
                        if (modelValue) {
                            result.model = cleanModelName(modelValue);
                        }
                    } else if (matchesLabel(['reference number', 'reference'], ['numéro de référence', 'référence'])) {
                        // Reference number is usually in an <a> tag
                        const refLink = $valueCell.find('a').first();
                        if (refLink.length > 0) {
                            result.referenceNumber = refLink.text().trim();
                        } else if (value) {
                            result.referenceNumber = value;
                        }
                    } else if (matchesLabel(['year of production', 'year', 'année de fabrication'], 
                                           ['année de production', 'année', 'année de fabrication'])) {
                        // Check for "unknown" in both English and French
                        const valueLower = value.toLowerCase();
                        if (value && valueLower !== 'unknown' && valueLower !== 'inconnu' && valueLower !== 'inconnue') {
                            // Extract year number from text (e.g., "1998 (Informations approximatives)" -> 1998)
                            const yearMatch = value.match(/\b(19|20)\d{2}\b/);
                            if (yearMatch) {
                                const year = parseInt(yearMatch[0]);
                                if (!isNaN(year) && year >= 1900 && year <= 2100) {
                                    result.year = year;
                                }
                            } else {
                                // Fallback: try to parse the whole value
                                const year = parseInt(value);
                                if (!isNaN(year) && year >= 1900 && year <= 2100) {
                                    result.year = year;
                                }
                            }
                        }
                    } else if (matchesLabel('condition', 'état')) {
                        // Condition might be in a button or just text
                        const conditionButton = $valueCell.find('button').first();
                        let conditionText = '';
                        if (conditionButton.length > 0) {
                            conditionText = conditionButton.text().trim();
                        } else if (value) {
                            conditionText = value;
                        }
                        if (conditionText) {
                            const conditionLower = conditionText.toLowerCase();
                            // English conditions: used, very good, fine, fair, scrap, worn, unworn, new
                            // French conditions: utilisé, très bon, bon, correct, usé, porté, non porté, neuf, jamais porté, état neuf
                            if (conditionLower.includes('used') || conditionLower.includes('utilisé') ||
                                conditionLower.includes('very good') || conditionLower.includes('très bon') ||
                                conditionLower.includes('fine') || conditionLower.includes('bon') ||
                                conditionLower.includes('fair') || conditionLower.includes('correct') ||
                                conditionLower.includes('scrap') || conditionLower.includes('usé') ||
                                conditionLower.includes('worn') || (conditionLower.includes('porté') && !conditionLower.includes('jamais porté'))) {
                                result.condition = 'worn';
                            } else if (conditionLower.includes('unworn') || conditionLower.includes('non porté') ||
                                      conditionLower.includes('new') || conditionLower.includes('neuf') ||
                                      conditionLower.includes('jamais porté') || conditionLower.includes('état neuf')) {
                                result.condition = 'unworn';
                            }
                        }
                    } else if (matchesLabel('gender', 'genre')) {
                        result.gender = value;
                    } else if (matchesLabel('location', ['lieu', 'emplacement', 'localisation'])) {
                        result.location = value;
                    } else if (matchesLabel(['content delivered', 'delivered with', 'included'], 
                                           ['contenu livré', 'livré avec', 'fourni avec'])) {
                        // Extract box and paper info from "Contenu livré" field
                        // This field ALWAYS overrides JSON-LD values (it's the most authoritative source)
                        const contentLower = value.toLowerCase();
                        
                        // Reset values first (HTML table is authoritative)
                        let boxSet = false;
                        let paperSet = false;
                        
                        // Check for "without"/"sans" (without) FIRST to avoid false positives
                        // Check for box without (English and French)
                        if (contentLower.includes('without box') || contentLower.includes('sans coffret') ||
                            contentLower.includes('sans boîte') || contentLower.includes('sans étui') ||
                            contentLower.includes('no box') || contentLower.includes('pas de boîte')) {
                            result.originalBox = false;
                            boxSet = true;
                        }
                        // Check for papers without (English and French)
                        if (contentLower.includes('without paper') || contentLower.includes('without papers') ||
                            contentLower.includes('sans papiers') || contentLower.includes('sans certificat') ||
                            contentLower.includes('sans carte') || contentLower.includes('no paper') ||
                            contentLower.includes('no papers') || contentLower.includes('pas de papiers')) {
                            result.originalPaper = false;
                            paperSet = true;
                        }
                        
                        // Then check for positive matches (only if not already set to false)
                        // Check for box (English and French) - prioritize "with"/"avec" and "original"/"d'origine" patterns
                        if (!boxSet) {
                            if (contentLower.includes('with original box') || contentLower.includes('avec coffret') ||
                                contentLower.includes('avec boîte') || contentLower.includes('coffret d\'origine') ||
                                contentLower.includes('boîte d\'origine') || contentLower.includes('with box')) {
                                result.originalBox = true;
                                boxSet = true;
                            } else if (contentLower.includes('coffret') || contentLower.includes('boîte') || 
                                      contentLower.includes('étui') || contentLower.includes('box')) {
                                result.originalBox = true;
                                boxSet = true;
                            }
                        }
                        
                        // Check for papers (English and French) - prioritize "with"/"avec" and "original"/"d'origine" patterns
                        if (!paperSet) {
                            if (contentLower.includes('with original paper') || contentLower.includes('with original papers') ||
                                contentLower.includes('avec papiers') || contentLower.includes('papiers d\'origine') ||
                                contentLower.includes('certificat d\'origine') || contentLower.includes('carte d\'origine') ||
                                contentLower.includes('with paper') || contentLower.includes('with papers')) {
                                result.originalPaper = true;
                                paperSet = true;
                            } else if (contentLower.includes('papiers') || contentLower.includes('certificat') ||
                                      contentLower.includes('carte') || contentLower.includes('paper') ||
                                      contentLower.includes('papers') || contentLower.includes('certificate') ||
                                      contentLower.includes('card')) {
                                result.originalPaper = true;
                                paperSet = true;
                            }
                        }
                        
                        // Note: If neither box nor paper is mentioned in "Contenu livré", 
                        // we keep the values from JSON-LD/description (don't override)
                    }
                    // Note: price, currency are extracted from HTML price element
                    // Note: images are extracted from HTML img elements
                });
            });
        }
    }

    return result;
}

// Scrape watch details using HTTP requests with retry logic
const scrapeWatchDetails = async (watchUrl, retryCount = 0, maxRetries = 3) => {
    try {
        const html = await fetchWatchDetailHtml(watchUrl);
        const details = extractWatchDetailsFromHtml(html, watchUrl);

        if (!details || (!details.brand && !details.model && !details.referenceNumber)) {
            throw new Error('Insufficient data extracted from page');
        }

        return details;
    } catch (error) {
        // Retry logic with exponential backoff
        if (retryCount < maxRetries) {
            const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
            await new Promise(resolve => setTimeout(resolve, delay));
            return scrapeWatchDetails(watchUrl, retryCount + 1, maxRetries);
        }
        
        console.error(`Failed to scrape after ${maxRetries} retries: ${watchUrl}`);
        return null;
    }
}

// REMOVED: scrapeWatchDetailsOld - unused function (~500 lines) removed to reduce code size

// Close browser and cleanup
const closeBrowser = async () => {
    if (monitorState.browser) {
        await monitorState.browser.close();
        console.log('Browser closed');
    }
}

const scrapeWatchData = async () => {
    try {
        // Step 0: Initialize browser and get cookies for HTTP requests
        console.log('\n========================================');
        console.log('Step 0: Initializing browser to get cookies...');
        console.log('========================================\n');
        await initBrowser();
        await getCookiesFromBrowser();
        console.log('✅ Cookies retrieved, can now use HTTP requests\n');

        // Step 1: Collect all watch URLs from all pages (using HTTP requests with cookies)
        console.log('========================================');
        console.log('Step 1: Collecting watch URLs from all pages (using HTTP requests with cookies)...');
        console.log('========================================\n');
        const watchUrls = await scrapeWatchListings();
        console.log(`\n✅ Found ${watchUrls.length} total watch URLs across all pages\n`);
        if (watchUrls.length > 0) {
            console.log('First 5 URLs:');
            watchUrls.slice(0, 5).forEach((url, idx) => {
                console.log(`  ${idx + 1}. ${url}`);
            });
            console.log('');
        }

        // Only continue if we found watch URLs
        if (watchUrls.length === 0) {
            console.log('No watch URLs found, skipping detail scraping.');
            return [];
        }

        // Step 2: Scrape details for each watch URL
        console.log('========================================');
        console.log('Step 2: Scraping details for each watch...');
        console.log('========================================\n');
        
        const watchDataPath = path.join(__dirname, '..', 'watchData.json');
        let watchData = [];
        
        // Load existing data if file exists (for resume capability)
        try {
            if (fs.existsSync(watchDataPath)) {
                const existingData = fs.readFileSync(watchDataPath, 'utf8');
                watchData = JSON.parse(existingData);
                console.log(`📂 Loaded ${watchData.length} existing watch(es) from watchData.json`);
            }
        } catch (error) {
            console.log('⚠️  Could not load existing watchData.json, starting fresh');
            watchData = [];
        }

        // Helper function to save watch data incrementally
        const saveWatchData = () => {
            try {
                fs.writeFileSync(watchDataPath, JSON.stringify(watchData, null, 2));
                console.log(`💾 Saved ${watchData.length} watch(es) to watchData.json`);
            } catch (error) {
                console.error(`❌ Error saving watchData.json: ${error.message}`);
            }
        };

        // Batch processing configuration
        const CONCURRENT_REQUESTS = 10; // Number of requests to send simultaneously
        let processedCount = 0;
        let successCount = 0;
        let failCount = 0;

        // Process URLs in batches
        for (let batchStart = 0; batchStart < watchUrls.length; batchStart += CONCURRENT_REQUESTS) {
            const batchEnd = Math.min(batchStart + CONCURRENT_REQUESTS, watchUrls.length);
            const batch = watchUrls.slice(batchStart, batchEnd);
            const batchNumber = Math.floor(batchStart / CONCURRENT_REQUESTS) + 1;
            const totalBatches = Math.ceil(watchUrls.length / CONCURRENT_REQUESTS);

            console.log(`\n📦 Batch ${batchNumber}/${totalBatches}: Processing ${batch.length} watch(es) concurrently...`);

            // Process all URLs in the batch concurrently
            const batchPromises = batch.map(async (watchUrl, batchIndex) => {
                const globalIndex = batchStart + batchIndex + 1;
                try {
                    console.log(`  [${globalIndex}/${watchUrls.length}] Processing: ${watchUrl}`);
                    const details = await scrapeWatchDetails(watchUrl);
                    
                    if (details) {
                        console.log(`  ✅ Successfully scraped watch ${globalIndex}`);
                        return { 
                            success: true, 
                            index: globalIndex,
                            data: {
                                index: globalIndex, // Explicit extraction order index
                                brand: details.brand,
                                model: details.model,
                                referenceNumber: details.referenceNumber,
                                year: details.year,
                                price: details.price,
                                currency: details.currency,
                                originalBox: details.originalBox,
                                originalPaper: details.originalPaper,
                                condition: details.condition,
                                location: details.location,
                                images: details.images,
                                watchUrl: details.watchUrl
                            }
                        };
                    } else {
                        console.log(`  ❌ Failed to scrape watch ${globalIndex}`);
                        return { success: false, index: globalIndex };
                    }
                } catch (error) {
                    console.log(`  ❌ Error scraping watch ${globalIndex}: ${error.message}`);
                    return { success: false, index: globalIndex, error: error.message };
                }
            });

            // Wait for all requests in the batch to complete
            const results = await Promise.allSettled(batchPromises);
            
            // Collect successful results and add them to watchData (maintain order)
            const batchResults = [];
            let batchSuccess = 0;
            let batchFail = 0;
            
            results.forEach((result) => {
                processedCount++;
                if (result.status === 'fulfilled' && result.value && result.value.success && result.value.data) {
                    batchResults.push(result.value.data);
                    successCount++;
                    batchSuccess++;
                } else {
                    failCount++;
                    batchFail++;
                }
            });
            
            // Add all successful results to watchData (sorted by index to maintain order)
            batchResults.sort((a, b) => a.index - b.index);
            watchData.push(...batchResults);

            // Save data after each batch completes
            saveWatchData();
            console.log(`  📊 Batch ${batchNumber} complete: ${batchSuccess} succeeded, ${batchFail} failed (${processedCount}/${watchUrls.length} total)`);

            // Small delay between batches to avoid overwhelming the server
            if (batchEnd < watchUrls.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        console.log('\n========================================');
        console.log('Summary');
        console.log('========================================');
        console.log(`Total URLs processed: ${watchUrls.length}`);
        console.log(`Successfully scraped: ${watchData.length}`);
        console.log(`Failed: ${watchUrls.length - watchData.length}`);
        
        if (watchData.length > 0) {
            const brands = watchData.filter(w => w.brand).map(w => w.brand);
            const uniqueBrands = [...new Set(brands)];
            console.log(`\nBrands found: ${uniqueBrands.length}`);
            console.log(`  ${uniqueBrands.slice(0, 10).join(', ')}${uniqueBrands.length > 10 ? '...' : ''}`);
            
            const totalImages = watchData.reduce((sum, w) => sum + (w.images ? w.images.length : 0), 0);
            console.log(`\nTotal images collected: ${totalImages}`);
            console.log(`Average images per watch: ${(totalImages / watchData.length).toFixed(1)}`);
            
            const withBox = watchData.filter(w => w.originalBox).length;
            const withPaper = watchData.filter(w => w.originalPaper).length;
            console.log(`\nWatches with original box: ${withBox}`);
            console.log(`Watches with original papers: ${withPaper}`);
        }
        
        console.log('\n========================================\n');

        // Final save (already saved incrementally, but save once more for confirmation)
        saveWatchData();
        console.log(`✅ Final watch data saved to ${watchDataPath} (${watchData.length} items)`);

        try {
            const response = await axios.post(config.BACK_END_URL, {
                parentUrl: config.PARENT_URL,
                watchData: watchData
            }, {
                timeout: 10000
            });
            console.log('✅ Watch data posted successfully to backend');
        } catch (error) {
            console.log('⚠️  Could not post to backend (this is OK if backend is not running):', error.message);
        }

        return watchData;
    } catch (error) {
        console.error('Error scraping watch data:', error.message);
        return [];
    } finally {
        await closeBrowser();
    }
}

const startScheduler = async () => {
    const SCRAPE_INTERVAL = 10 * 60 * 60 * 1000; // 10 hours in milliseconds

    console.log('Starting scheduler...');
    console.log(`Scraping interval: 10 hours (${SCRAPE_INTERVAL / 1000 / 60} minutes)`);

    console.log('Running initial scrape...');
    await scrapeWatchData();

    setInterval(async () => {
        try {
            console.log('Running scheduled scrape...');
            await scrapeWatchData();
        } catch (error) {
            console.error('Error in scheduled scrape:', error.message);
        }
    }, SCRAPE_INTERVAL);

}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down scheduler...');
    await closeBrowser();
    process.exit(0);
});

// Start the scheduler
startScheduler()
