"use strict";
const express = require("express");
const ejs = require("ejs");
const { LRUCache } = require("lru-cache");

const config = require("./config.js");

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const PORT = process.env.PORT || 3008;
const VALID_URLS = ["bsky.app", "staging.bsky.app"];

const debug_log = false;

function log(s) {
    if(debug_log){
        console.log(s)
    }
}

const app = express();

app.set("view engine", "ejs");
app.use(express.static("public"));
app.use((err, req, res, next) => {
    res.status(500).render("error", {
        error: "There was an error loading this page."
    });
});


let token = "";
let auth_token_expires = new Date().getTime();
let refresh = "";
getAuthToken();

function getAuthToken () {
    log("getAuthToken called ");
    return fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            "identifier": config.HANDLE,
            "password": config.PASSWORD
        })
    })
    .then (response => {
        log("getAuthToken status:'"+response.status+"' statustText:'"+response.statusText+"';")
        return response.json().then((data) => {
            //log(data);
            if (response.status==200) {
                token = data.accessJwt;
                refresh = data.refreshJwt;
                log("getAuthToken response: token='"+token+"'; refresh='"+refresh+"';")
                auth_token_expires = new Date().getTime() + 1000 *5 * 60 * 30;
            }
        })
    })
    .catch(err =>{
        //catch err 
        console.log(err);
    });                       
}

function refreshAuthToken () {
    log("refreshAuthToken called with: token='"+token+"'; refresh='"+refresh+"';");
    return fetch("https://bsky.social/xrpc/com.atproto.server.refreshSession", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + refresh
        }
    })
    .then (response => {
        log("refreshAuthToken status:'"+response.status+"' statustText:'"+response.statusText+"';")
        return response.json().then((data) => {
            //log(data);
            if (response.status==200) {
                token = data.accessJwt;
                refresh = data.refreshJwt;
                auth_token_expires = new Date().getTime() + 1000 *5 * 60 * 30;
                log("refreshAuthToken response: token='"+token+"'; refresh='"+refresh+"';")
            }
        })
    })
    .catch(err =>{
        //catch err 
        console.log(err);
    });                       
}

function flattenReplies (replies, author_handle, iteration = 0) {
    // replies are nested objects of .replies, so we need to flatten them
    let all_replies = [];

    if (iteration > 20) {
        return all_replies;
    }

    if (!replies || replies.length == 0) {
        return all_replies;
    }

    for (const reply of replies) {
        if (reply.post.author.handle != author_handle) {
            continue;
        }

        all_replies.push(reply);

        if (reply.replies && reply.replies.length > 0) {
            all_replies = all_replies.concat(flattenReplies(reply.replies, author_handle, iteration + 1));
        }
    }

    return all_replies;
}

const options = {
    max: 500,

    // for use with tracking overall storage size
    maxSize: 5000,
    sizeCalculation: (value, key) => {
        return 1
    },

    // how long to live in ms
    ttl: 1000 * 60 * 5,

    // return stale items before removing from cache?
    allowStale: false,

    updateAgeOnGet: false,
    updateAgeOnHas: false,
}

const cache = new LRUCache(options);

app.route("/").get(async (req, res) => {
    if (new Date().getTime() > auth_token_expires) {
        await refreshAuthToken();
    }

    const url = req.query.url;
    let parsed_url;

    if (!url) {
        // load home.ejs
        res.render("home");
        return;
    }

    try {
        parsed_url = new URL(url);
    } catch (e) {
        res.render("error", {
            error: "Invalid URL"
        });
        return;
    }

    const domain = parsed_url.hostname;

    if (!VALID_URLS.includes(domain)) {
        res.render("error", {
            error: "Invalid URL"
        });
        return;
    }

    const show_thread = (req.query.show_thread == "on") || (req.query.show_thread == "t"); //support legacy value of 't' for existing URLs
    const hide_parent = req.query.hide_parent == "on";

    const handle = parsed_url.pathname.split("/")[2];
    const post_id = parsed_url.pathname.split("/")[4];

    if (!handle || !post_id) {
        res.render("error", {
            error: "Invalid URL"
        });
        return;
    }
    let query_parts = [];
    if (show_thread){
        query_parts.push("show_thread=on");
    }
    if (hide_parent){
        query_parts.push("hide_parent=on");
    }
    query_parts.push("url="+url);
    const query_string = "?" + query_parts.join("&");
    if (cache.has(query_string)) {
        const data = cache.get(query_string);
        res.render("post", data);
        return;
    }
    log("resolveHandle fetch: token='"+token+"'; refresh='"+refresh+"';");
    return fetch("https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=" + handle, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token
        }
    }).then((response) => {
        response.json().then((did) => {
            log("getPostThread fetch: token='"+token+"'; refresh='"+refresh+"';");
            fetch(`https://bsky.social/xrpc/app.bsky.feed.getPostThread?uri=at://${did.did}/app.bsky.feed.post/${post_id}`, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + token
                },
            }).then((response) => {
                response.json().then((data) => {
                    let embed = null;
                    let embed_type = null;

                    if (data && data.thread && data.thread.post) {
                        if (data.thread.post.embed && data.thread.post.embed.record) {
                            embed = data.thread.post.embed.record;
                            embed_type = "record";
                        } else if (data.thread.post.embed && data.thread.post.embed.images) {
                            embed = data.thread.post.embed.images;
                            embed_type = "images";
                        } else if (data.thread.post.embed && data.thread.post.embed.external) {
                            embed = data.thread.post.embed.external;
                            embed_type = "external";
                        }
                    } else {
                        res.render("error", {
                            error: "Invalid URL"
                        });
                        return;
                    }

                    const createdAt = new Date(data.thread.post.record.createdAt);

                    const readableDate = createdAt.toLocaleString("en-US", {
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                        hour: "numeric",
                        minute: "numeric",
                        second: "numeric",
                        hour12: true,
                    }).replace(",", "");

                    const author_handle = data.thread.post.author.handle;

                    const all_replies = flattenReplies(data.thread.replies, author_handle);

                    let parent = null;

                    if (hide_parent) {
                        parent = null;
                    } else {
                        parent = data.thread.parent ? data.thread.parent : null;
                    }

                    const response_data = {
                        data: data.thread.post.record,
                        author: data.thread.post.author,
                        embed: embed,
                        embed_type: embed_type,
                        url: "https://bsky.link/" + query_string,
                        post_url: url,
                        reply_count: data.thread.post.replyCount,
                        like_count: data.thread.post.likeCount,
                        repost_count: data.thread.post.repostCount,
                        created_at: readableDate,
                        replies: show_thread ? all_replies : [],
                        parent: parent
                    };

                    cache.set(query_string, response_data);

                    res.render("post", response_data);
                });
            });
        });
    });
});

app.route("/feed").get(async (req, res) => {
    if (new Date().getTime() > auth_token_expires) {
        await refreshAuthToken();
    }

    const user = req.query.user;

    if (!user) {
        res.render("error", {
            error: "Invalid user"
        });
        return;
    }
    log("getAuthorFeed fetch: token='"+token+"'; refresh='"+refresh+"';");
    return fetch("https://bsky.social/xrpc/app.bsky.feed.getAuthorFeed?actor=" + user, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token
        }
    }).then((response) => {
        response.json().then((data) => {
            const posts = data.feed;

            // if no posts, error out
            if (!posts || posts.length == 0) {
                res.render("error", {
                    error: "No posts found"
                });
                return;
            }

            let embed_count = 0;

            for (const p of posts) {
                const post = p.post;
                let embed = [];
                let embed_type = null;
                if (post.embed && post.embed.record) {
                    embed = post.embed.record;
                    embed_type = "record";

                    if (embed.record) {
                        embed = embed.record;
                    }

                    embed_count++;
                } else if (post.embed && post.embed.images) {
                    embed = post.embed.images;
                    embed_type = "images";
                } else {
                    embed = [];
                    embed_type = null;
                }

                post.embed = embed;
                post.embed_type = embed_type;

                const createdAt = new Date(post.record.createdAt);

                const readableDate = createdAt.toLocaleString("en-US", {
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                    hour: "numeric",
                    minute: "numeric",
                    second: "numeric",
                    hour12: true,
                }).replace(",", "");

                post.record.createdAt = readableDate;
            }

            console.log("Embed count: " + embed_count);
            
            res.render("feed", {
                author: user,
                posts: data.feed,
                url: "https://bsky.link/feed?user=" + user,
                post_url: "https://staging.bsky.social/profile/" + user
            });
        });
    });
});

// run in production mode
app.listen(PORT, () => {
    console.log("Server started on port " + PORT);
});