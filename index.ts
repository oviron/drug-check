import axios from 'axios'
import cron from 'node-cron'
import TelegramBot from 'node-telegram-bot-api'
import dotenv from 'dotenv'
import pino from 'pino'
import {
  addSubscriber,
  removeSubscriber,
  getActiveSubscribers,
  isSubscribed,
  getStatistics,
  Subscriber
} from './database'

dotenv.config()

// Initialize logger
const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: false,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  }
})

// Validate configuration
function validateConfig() {
  const errors: string[] = []
  
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    errors.push('TELEGRAM_BOT_TOKEN не найден в .env')
  }
  
  if (!process.env.DRUGS_TO_CHECK) {
    errors.push('DRUGS_TO_CHECK не найден в .env')
  }
  
  if (!process.env.CRON_SCHEDULE) {
    errors.push('CRON_SCHEDULE не найден в .env')
  } else if (!cron.validate(process.env.CRON_SCHEDULE)) {
    errors.push(`CRON_SCHEDULE "${process.env.CRON_SCHEDULE}" не валидный`)
  }
  
  if (errors.length > 0) {
    logger.error('Ошибки конфигурации:')
    errors.forEach(err => logger.error(`  - ${err}`))
    process.exit(1)
  }
  
  logger.info('Конфигурация валидна')
}

validateConfig()

// Track API errors for retry
const apiErrorDrugs = new Set<string>()
let retryTimer: NodeJS.Timeout | null = null

// Initialize Telegram bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: true })
logger.info(`Бот инициализирован с токеном: ${process.env.TELEGRAM_BOT_TOKEN!.substring(0, 10)}...`)

// Log all incoming messages for debugging
bot.on('message', (msg) => {
  logger.debug(`Получено сообщение от ${msg.from?.username || msg.from?.id}: ${msg.text}`)
})

// Command: /start - Subscribe to notifications
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id
  const user = msg.from
  
  logger.info(`Команда /start от пользователя ${user?.username || user?.id} (chat_id: ${chatId})`)
  
  if (!user) return
  
  const subscriber: Subscriber = {
    chatId,
    username: user.username,
    firstName: user.first_name,
    lastName: user.last_name
  }
  
  addSubscriber(subscriber)
  logger.info(`Пользователь ${chatId} добавлен в подписчики`)
  
  await bot.sendMessage(chatId, 
    `✅ Вы успешно подписались на уведомления о наличии лекарств!\n\n` +
    `Теперь вы будете получать сообщения, когда отслеживаемые препараты появятся в наличии.\n\n` +
    `Отслеживаемые препараты:\n${(process.env.DRUGS_TO_CHECK || 'Пентаса').split(',').map(d => `• ${d.trim()}`).join('\n')}\n\n` +
    `Чтобы отписаться, используйте команду /stop`
  )
  logger.info(`Отправлено приветственное сообщение пользователю ${chatId}`)
})

// Command: /stop - Unsubscribe from notifications
bot.onText(/\/stop/, async (msg) => {
  const chatId = msg.chat.id
  const user = msg.from
  
  logger.info(`Команда /stop от пользователя ${user?.username || user?.id} (chat_id: ${chatId})`)
  
  const wasSubscribed = removeSubscriber(chatId)
  
  if (wasSubscribed) {
    logger.info(`Пользователь ${chatId} отписался`)
    await bot.sendMessage(chatId, 
      `❌ Вы отписались от уведомлений.\n\n` +
      `Чтобы снова подписаться, используйте команду /start`
    )
  } else {
    logger.warn(`Пользователь ${chatId} не был подписан`)
    await bot.sendMessage(chatId, 
      `ℹ️ Вы не были подписаны на уведомления.\n\n` +
      `Используйте команду /start для подписки`
    )
  }
})

// Command: /status - Check subscription status
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id
  const user = msg.from
  const subscribed = isSubscribed(chatId)
  
  logger.info(`Команда /status от пользователя ${user?.username || user?.id} (chat_id: ${chatId}) - ${subscribed ? 'подписан' : 'не подписан'}`)
  
  if (subscribed) {
    await bot.sendMessage(chatId, 
      `✅ Вы подписаны на уведомления\n\n` +
      `Отслеживаемые препараты:\n${(process.env.DRUGS_TO_CHECK || 'Пентаса').split(',').map(d => `• ${d.trim()}`).join('\n')}`
    )
  } else {
    await bot.sendMessage(chatId, 
      `❌ Вы не подписаны на уведомления\n\n` +
      `Используйте команду /start для подписки`
    )
  }
})

interface DrugCheckResult {
  isAvailable: boolean
  pharmacyCount?: number
  pharmacies?: any[]
}

// Check drug availability using API
async function checkDrug(drugName: string): Promise<DrugCheckResult> {
  logger.info(`Начинаю проверку препарата: ${drugName}`)
  
  try {
    const response = await axios.get('https://gorzdrav.spb.ru/_api/api/v2/medication/pharmacies/search', {
      params: {
        nom: drugName.toLowerCase(),
        isLgot: true
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://gorzdrav.spb.ru/pharm-drug-search?tab=lgot'
      },
      timeout: 30000
    })
    
    logger.info(`API ответил со статусом: ${response.status}`)
    
    // Проверяем успешность запроса
    if (response.data && response.data.success === false) {
      logger.error(`API вернул ошибку: ${response.data.message}`)
      logger.error(`Код ошибки: ${response.data.errorCode}, RequestId: ${response.data.requestId}`)
      throw new Error(`API Error: ${response.data.message}`)
    }
    
    if (response.data && response.data.success && response.data.result) {
      const pharmacies = response.data.result
      const isAvailable = pharmacies.length > 0
      
      if (isAvailable) {
        logger.info(`${drugName}: НАЙДЕН в ${pharmacies.length} аптеках`)
        
        // Выводим первые 3 аптеки для информации
        pharmacies.slice(0, 3).forEach((pharmacy: any, index: number) => {
          logger.info(`  ${index + 1}. ${pharmacy.storeName} (${pharmacy.storeDistrict}): ${pharmacy.drugName}`)
        })
      } else {
        logger.info(`${drugName}: НЕ НАЙДЕН`)
      }
      
      return {
        isAvailable,
        pharmacyCount: pharmacies.length,
        pharmacies: pharmacies.slice(0, 3) // Первые 3 аптеки для сообщения
      }
    } else {
      logger.error(`Неожиданный формат ответа от API`, response.data)
      throw new Error('Неожиданный формат ответа от API')
    }
  } catch (error: any) {
    if (error.response) {
      // Сервер ответил с ошибкой
      logger.error(`API ответил с ошибкой для ${drugName}: ${error.response.status}`)
      logger.error(`Данные ошибки:`, error.response.data)
    } else if (error.request) {
      // Запрос был сделан, но ответ не получен
      logger.error(`Нет ответа от API для ${drugName}`)
    } else {
      // Что-то еще
      logger.error(`Ошибка при проверке препарата ${drugName}:`, error.message)
    }
    throw error // Пробрасываем ошибку дальше, чтобы не отправлять уведомления
  }
}

// Send notification to all subscribers
async function sendNotificationToSubscribers(drugName: string, result: DrugCheckResult) {
  const subscribers = getActiveSubscribers()
  
  logger.info(`Отправляю уведомления ${subscribers.length} подписчикам для препарата "${drugName}" (${result.isAvailable ? 'В НАЛИЧИИ' : 'НЕТ в наличии'})`)
  
  if (subscribers.length === 0) {
    logger.info(`Нет активных подписчиков для отправки уведомлений`)
    return
  }
  
  let message = ''
  
  if (result.isAvailable && result.pharmacyCount && result.pharmacies) {
    message = `✅ <b>Препарат "${drugName}" ЕСТЬ В НАЛИЧИИ!</b>\n\n` +
      `🏥 Найден в <b>${result.pharmacyCount}</b> аптеках Санкт-Петербурга\n\n` +
      `📍 Ближайшие аптеки:\n`
    
    result.pharmacies.forEach((pharmacy: any, index: number) => {
      message += `${index + 1}. <b>${pharmacy.storeName}</b>\n` +
        `   📍 ${pharmacy.storeAddress} (${pharmacy.storeDistrict})\n` +
        `   🕐 ${pharmacy.storeWorkingTime.split(' ').slice(0, 4).join(' ')}\n` +
        `   💊 ${pharmacy.drugName}\n\n`
    })
    
    message += `🔗 <a href="https://gorzdrav.spb.ru/pharm-drug-search?tab=lgot">Посмотреть все аптеки</a>`
  } else {
    message = `❌ <b>Препарат "${drugName}" НЕТ в наличии</b>\n\n` +
      `К сожалению, препарат не найден в аптеках Санкт-Петербурга.\n\n` +
      `🔗 <a href="https://gorzdrav.spb.ru/pharm-drug-search?tab=lgot">Проверить самостоятельно</a>`
  }
  
  let successCount = 0
  let errorCount = 0
  
  for (const subscriber of subscribers) {
    try {
      await bot.sendMessage(subscriber.chatId, message, { 
        parse_mode: 'HTML',
        disable_web_page_preview: true 
      })
      successCount++
      logger.info(`✓ Сообщение отправлено пользователю ${subscriber.chatId} (${subscriber.username || 'без username'})`)
    } catch (error) {
      errorCount++
      logger.error(`✗ Ошибка отправки сообщения пользователю ${subscriber.chatId}:`, error)
      // If bot was blocked by user, deactivate subscription
      if (error instanceof Error && error.message.includes('bot was blocked')) {
        removeSubscriber(subscriber.chatId)
        logger.info(`Пользователь ${subscriber.chatId} удален из подписчиков (бот заблокирован)`)
      }
    }
  }
  
  logger.info(`Итого: отправлено ${successCount}, ошибок ${errorCount}`)
}

// Flag to prevent concurrent checks
let isChecking = false

// Check all drugs
async function checkAllDrugs() {
  // Prevent concurrent execution
  if (isChecking) {
    logger.warn(`Проверка уже выполняется, пропускаю...`)
    return
  }
  
  isChecking = true
  
  try {
    const drugs = (process.env.DRUGS_TO_CHECK || 'Пентаса').split(',').map(d => d.trim())
    const activeSubscribers = getActiveSubscribers()
    
    logger.info(`=== Начинаю проверку препаратов ===`)
    logger.info(`Препараты: ${drugs.join(', ')}`)
    logger.info(`Активных подписчиков: ${activeSubscribers.length}`)
    
    for (let i = 0; i < drugs.length; i++) {
      const drug = drugs[i]
      try {
        const result = await checkDrug(drug)
        logger.info(`${drug}: ${result.isAvailable ? 'В НАЛИЧИИ' : 'нет в наличии'}`)
        
        // Always send notification for each drug
        await sendNotificationToSubscribers(drug, result)
        logger.info(`Отправлены уведомления для ${drug}`)
      } catch (error) {
        logger.error(`Ошибка при проверке ${drug}:`, error)
        // Не отправляем уведомления при ошибке API
        logger.warn(`Пропускаю отправку уведомлений для ${drug} из-за ошибки API`)
        // Добавляем в список для повторной проверки
        apiErrorDrugs.add(drug)
      }
    }
    
    logger.info(`=== Проверка завершена ===`)
    
    // Schedule retry for drugs with API errors
    scheduleRetryForErrors()
  } finally {
    isChecking = false
  }
}

// Handle bot errors
bot.on('polling_error', (error) => {
  logger.error(`Telegram bot polling error:`, error)
})

// Log when bot is ready
bot.on('polling', () => {
  logger.info(`Telegram бот подключен и ожидает сообщения`)
})

// Get bot info on start
bot.getMe().then((botInfo) => {
  logger.info(`Бот запущен: @${botInfo.username} (id: ${botInfo.id})`)
}).catch((error) => {
  logger.error(`Ошибка при получении информации о боте:`, error)
})

// Function to retry failed drugs
function scheduleRetryForErrors() {
  if (apiErrorDrugs.size > 0) {
    // Cancel existing retry timer if any
    if (retryTimer) {
      clearTimeout(retryTimer)
    }
    
    logger.info(`Запланирована повторная проверка для ${apiErrorDrugs.size} препаратов через 1 минуту`)
    
    retryTimer = setTimeout(async () => {
      if (apiErrorDrugs.size > 0) {
        logger.info(`Запускаю повторную проверку для препаратов с ошибками: ${Array.from(apiErrorDrugs).join(', ')}`)
        const drugsToRetry = Array.from(apiErrorDrugs)
        apiErrorDrugs.clear() // Clear the set before retry
        
        for (const drug of drugsToRetry) {
          try {
            const result = await checkDrug(drug)
            logger.info(`${drug}: ${result.isAvailable ? 'В НАЛИЧИИ' : 'нет в наличии'}`)
            await sendNotificationToSubscribers(drug, result)
            logger.info(`Отправлены уведомления для ${drug}`)
          } catch (error) {
            logger.error(`Повторная ошибка при проверке ${drug}:`, error)
            logger.warn(`Препарат ${drug} будет проверен по основному расписанию`)
          }
        }
      }
    }, 60000) // 1 minute
  }
}

// Check if --check-now flag is passed
if (process.argv.includes('--check-now')) {
  logger.info('Запускаю разовую проверку...')
  checkAllDrugs().then(() => {
    logger.info('Проверка завершена')
    // Don't exit, keep bot running
  }).catch(error => {
    logger.error('Ошибка:', error)
  })
} else {
  // Start cron job
  const schedule = process.env.CRON_SCHEDULE!
  const stats = getStatistics()
  
  logger.info('===================================')
  logger.info('Запускаю мониторинг препаратов')
  logger.info(`Расписание проверок: ${schedule}`)
  logger.info(`Препараты: ${process.env.DRUGS_TO_CHECK!}`)
  logger.info(`Статистика БД: Всего ${stats.total_count}, Активных ${stats.active_count}, Отписавшихся ${stats.inactive_count}`)
  logger.info('===================================')
  logger.info('Telegram бот запущен и ожидает команды...')
  
  cron.schedule(schedule, () => {
    logger.info(`CRON: запуск проверки по расписанию`)
    checkAllDrugs()
  })
  
  // Run check immediately on start
  logger.info(`Запускаю первую проверку при старте...`)
  checkAllDrugs()
}
