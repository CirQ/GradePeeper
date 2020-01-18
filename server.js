
const assert = require('assert')

const cheerio = require('cheerio')
const qrcode = require('qrcode')
const qrcodeterminal = require('qrcode-terminal')
const redis = require('async-redis')
const superagent = require('superagent')
const tmp = require('tmp')
const { FileBox } = require('file-box')
const { Wechaty, log } = require('wechaty')
const { MemoryCard } = require('memory-card')
const { PuppetMock } = require('wechaty-puppet-mock')
// const { PuppetPadplus } = require('wechaty-puppet-padplus')

const config = require('./config')

const client = redis.createClient(config.redis_url)

class SystemProber {
    constructor(wxid, msger, jsessionid, courses) {
        this.wxid = wxid
        this.msger = msger
        this.jsessionid = jsessionid
        this.courses = courses
    }

    static async obtain(wxid, msger){
        const jid = await client.get(`JSESSIONID#${wxid}`)
        const crs = await client.smembers(`COURSES#${wxid}`)
        return new SystemProber(wxid, msger, jid, crs)
    }

    _refresh_cookie() {
        this.msger.say('需要重新扫码登陆哦~')
        superagent
            .get('https://cas.sustech.edu.cn/cas/login')
            .set('User-Agent', 'python-requests/2.21.0')
            .set('Connection', 'keep-alive')
            .end((err, res) => {
                const state = /var state = "(.*?)";/.exec(res.text)[1]
                const content = 'https://open.weixin.qq.com/connect/oauth2/authorize?' +
                                `appid=wx8839ace7048d181b&response_type=code&scope=snsapi_base&state=${state}&` +
                                'redirect_uri=https%3A%2F%2Fcas.sustech.edu.cn%2Fcas%2Flogin%3Fwechat%3Dcallback&a=1#wechat_redirect'
                let path = tmp.tmpNameSync({postfix:'.png'})
                let cas_tmp = res.headers['set-cookie'][0].split(';')[0]
                qrcode.toFile(path, content).then( err => {
                    if(!err){
                        const fileBox = FileBox.fromFile(path)
                        this.msger.say(fileBox)

                        let int = setInterval(() => {
                            const agent = superagent.agent()
                            agent.get(`https://cas.sustech.edu.cn/cas/login?wechat=check&state=${state}`)
                                .set('User-Agent', 'python-requests/2.21.0')
                                .set('Connection', 'keep-alive')
                                .set('Cookie', cas_tmp)
                                .end((err, res) => {
                                    let s = res.text
                                    const ret = JSON.parse(s.substring(1,s.length-1))
                                    if(ret.status === 'success') {
                                        const code = ret.code
                                        agent.post('https://cas.sustech.edu.cn/cas/login?service=http%3A%2F%2Fgradinfo.sustech.edu.cn%2Fssfw%2Fj_spring_ids_security_check')
                                        .set('User-Agent', 'python-requests/2.21.0')
                                        .set('Connection', 'keep-alive')
                                        .set('Cookie', cas_tmp)
                                        .send(`status=success&confirmUrl=&wechat=success&state=${state}&code=${code}`)
                                        .redirects(1)
                                        .end((err, res) => {
                                            const jid = res.headers['set-cookie'][0].split(';')[0].split('JSESSIONID=')[1]
                                            client.set(`JSESSIONID#${this.wxid}`, jid)
                                            clearInterval(int)
                                            this.msger.say('登陆成功！重新开始查询吧~')
                                        })
                                    }
                                    else {
                                        console.log('heartbeating ' + ret.status)
                                    }
                                })
                        }, 5*1000)
                        setTimeout(() => clearInterval(int), 60*1000)
                    }
                })
            });
    }

    async _handleResponse(text) {
        let results = []
        let self = this
        let $ = cheerio.load(text)
        $('#table_cjxx>tbody>.t_con').each(function() {
            const cid = $(this).find(':nth-child(2)').text().trim()
            if(self.courses.includes(cid)){
                results.push({
                    cid: cid,
                    name: $(this).find(':nth-child(3)').text().trim(),
                    grade: +$(this).find(':nth-child(6)').text(),
                    gpa: +$(this).find(':nth-child(7)').text(),
                    status: $(this).find(':nth-child(8)').text().trim(),
                })
                self.courses = self.courses.filter(x => x!==cid)
            }
        })
        return results
    }

    async probe() {
        try {
            var res = await superagent
                .get('http://gradinfo.sustech.edu.cn/ssfw/pygl/cjgl/cjcx.do')
                .set('Cookie', `JSESSIONID=${this.jsessionid}`)
                .send();
            if(res.status == 200) {
                let result = this._handleResponse(res.text)
                if(this.courses.length) {
                    this.msger.say(`Unknown Course [${this.courses}] Remove`)
                    const key = `COURSES#${this.wxid}`
                    this.courses.forEach(x => client.srem(key, x))
                }
                return result
            }
            else {
                console.error('not OK status: ' + res.status)
            }
        } catch (err) {
            console.error('request with error: ' + err)
            if(err.status == 401)
                this._refresh_cookie()
        }
        return null
    }
}



class WechatyServer {

    async _check(fromId, msger) {
        const pb = await SystemProber.obtain(fromId, msger)
        var result = await pb.probe()
        if(result.length == 0){
            msger.say('似乎没有关注课程成绩哦。。')
            return
        }
        result.forEach((gitem) => {
            if(isNaN(gitem.grade)) {
                const { name, cid } = gitem;
                msger.say(`【${name}/${cid}】还没有出分数哦~`)
            }
            else {
                const { name, cid, grade, gpa, status } = gitem;
                msger.say(`【${name}/${cid}】\n` +
                        `分数：${grade}\n` +
                        `折合绩点：${gpa}\n` +
                        `是否及格：${(status==='及格')&&'是' || '否'}`)
            }
        });
    }

    async _register(fromId, msger) {
        const key = `JSESSIONID#${fromId}`
        const exist = await client.exists(key)
        if(exist) {
            msger.say('已经注册过啦！')
        }
        else {
            client.set(key, 'salty')
            msger.say('注册成功啦！')
        }
    }

    async _showall(fromId, msger) {
        const cset = await client.smembers(`COURSES#${fromId}`)
        if(cset) {
            cset.sort()
            msger.say('已经关注的课程编号：\n' + cset.join('\n'))
        }
        else {
            msger.say('还没有关注任何课程哦~')
        }
    }

    async _add(fromId, courseId, msger) {
        const key = `COURSES#${fromId}`
        const exist = await client.sismember(key, courseId)
        if(exist) {
            msger.say(`已经关注过${courseId}啦！`)
        }
        else {
            client.sadd(key, courseId)
            msger.say(`成功关注${courseId}啦！`)
        }
    }
    
    async _drop(fromId, courseId, msger) {
        const key = `COURSES#${fromId}`
        const exist = await client.sismember(key, courseId)
        if(!exist) {
            msger.say(`还没有关注${courseId}啦！`)
        }
        else {
            client.srem(key, courseId)
            msger.say(`成功取关${courseId}啦！`)
        }
    }


    async onMessage(msg, payload) {
        if(payload.toId != this.wxid){ // send from myself
            assert.equal(payload.fromId, this.wxid)
            return
        }
        if(payload.type != 7)   // not text
            return

        const { fromId, text } = payload;
        switch(true) {  // https://stackoverflow.com/questions/2896626
            case /^peek peek peek$/.test(text):
                this._check(fromId, msg)
                break;
            case /^register$/.test(text):
                this._register(fromId, msg)
                break
            case /^showall$/.test(text):
                this._showall(fromId, msg)
                break
            case /^focus [A-Z0-9]+$/i.test(text):
                var cid = text.split(' ')[1].toUpperCase()
                this._add(fromId, cid, msg)
                break
            case /^loose [A-Z0-9]+$/i.test(text):
                var cid = text.split(' ')[1].toUpperCase()
                this._drop(fromId, cid, msg)
                break
        }
    }

    constructor(name='checker') {
        const DEFAULT_PUPPET = true
        if(DEFAULT_PUPPET) {
            this.bot = new Wechaty({ name: name })
        }
        else {
            const puppet = new PuppetMock({ memory: new MemoryCard() })
            // const ppp = new
            this.bot = new Wechaty({ name: name, puppet: puppet })
        }
        this.wxid = ''
    }

    init() {
        this.bot.on('scan', (qrcode, status) => {
            // when prompting bot-owner to login
            console.log(`Scan QR Code to login: ${status}`)
            // console.log('https://api.qrserver.com/v1/create-qr-code/?data='+encodeURIComponent(qrcode))
            qrcodeterminal.generate(qrcode, {small:true})
        })
        this.bot.on('login', user => {
            // when user successfully logined
            this.wxid = user.id
            console.log(`User ${user} logined`)
        })
        this.bot.on('message', async message => {
            // when got message
            await this.onMessage(message, message.payload)
        })
        this.bot.on('friendship', friendship => {
            // when receive friend request
            console.log(`Friendship: ${friendship}`)
        })
        // non sense
        // this.bot.on('heartbeat', data => {
        //     console.log(`Got heartbeat: ${data}`)
        // })
        return this.bot
    }



}

new WechatyServer().init()
    .start()
    .then(() => log.info('CheckerBot', 'Checker-Bot Started.'))
    .catch(err => {
        log.error('CheckerBot', err)
        client.end(true)
    })
