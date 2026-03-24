const resaleFeedController = require('../controllers/resaleFeedController');
const authenticateToken = require('../middleware/authMiddleware');

async function resaleFeedRoutes(fastify, options) {
  // Apply authentication middleware to all routes in this file
  fastify.addHook('preHandler', authenticateToken);

  // Route for refreshing the resale feed
  fastify.post(
    '/resale-feed/refresh',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  itemsGenerated: { type: 'integer', example: 12 },
                  lastRefresh: { type: 'string', format: 'date-time', example: '2025-07-18T22:16:32Z' },
                  insights: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        type: { type: 'string', enum: ['feed_quality', 'urgent', 'success', 'trend', 'tip', 'achievement', 'onboarding'] },
                        title: { type: 'string', example: '📊 Feed Quality Score' },
                        description: { type: 'string', example: 'Your feed scored 89/100 with 3 high-value opportunities' },
                        score: { type: ['number', 'null'] },
                        actionable: { type: 'boolean' },
                        action: { type: ['string', 'null'] }
                      }
                    }
                  },
                  achievements: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string', example: 'Profitable' },
                        description: { type: 'string', example: 'Made $100+ in profit' },
                        points: { type: 'integer', example: 200 }
                      }
                    }
                  },
                  personalizedRecommendations: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        type: { type: 'string', enum: ['category_focus', 'timing'] },
                        title: { type: 'string', example: 'Perfect Market Timing' },
                        description: { type: 'string', example: '3 items have excellent market conditions. Great time to sell!' },
                        priority: { type: 'string', enum: ['high', 'medium', 'low', 'urgent'] }
                      }
                    }
                  },
                  processingStats: {
                    type: 'object',
                    properties: {
                      totalProcessed: { type: 'integer', example: 25 },
                      successful: { type: 'integer', example: 18 },
                      errors: { type: 'integer', example: 0 },
                      skipped: { type: 'integer', example: 7 }
                    }
                  },
                  items: { type: 'array', items: { type: 'object' } }
                }
              }
            },
          },
          400: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'eBay account connection required to check resale prices.' },
              code: { type: 'string', example: 'EBAY_CONNECTION_REQUIRED' },
              requiresEbayConnection: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  items: { type: 'array', items: { type: 'object' } }
                }
              }
            }
          },
          404: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'User not found.' },
              code: { type: 'string', example: 'USER_NOT_FOUND' }
            }
          },
          409: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'Cannot refresh feed while Google accounts are syncing' },
              code: { type: 'string', example: 'ACCOUNTS_SYNCING' },
              accountsSyncing: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  items: { type: 'array', items: { type: 'object' } }
                }
              }
            }
          },
          500: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'An error occurred while refreshing the resale feed.' },
              code: { type: 'string', example: 'INTERNAL_ERROR' }
            }
          }
        },
      },
    },
    resaleFeedController.refreshFeed
  );

  // Route for fetching the resale feed
  fastify.get(
    '/resale-feed',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        itemName: { type: 'string' },
                        resaleValue: { type: ['number', 'null'] },
                        itemPrice: { type: 'number' },
                        profitMargin: { type: ['number', 'null'] },
                        recommendedAction: { type: ['string', 'null'] },
                        imageUrl: { type: ['string', 'null'] },
                        storeName: { type: ['string', 'null'] },
                        sellScore: { type: ['integer', 'null'] }
                      }
                    }
                  },
                  metadata: {
                    type: 'object',
                    properties: {
                      totalItems: { type: 'integer' },
                      lastRefresh: { type: ['string', 'null'], format: 'date-time' },
                      refreshAvailable: { type: 'boolean' },
                      needsFirstRefresh: { type: 'boolean' },
                      requiresEbayConnection: { type: 'boolean' },
                      message: { type: 'string' },
                      feedQuality: {
                        type: 'object',
                        properties: {
                          sellNowCount: { type: 'integer' },
                          considerSellingCount: { type: 'integer' },
                          watchCount: { type: 'integer' },
                          averageProfitMargin: { type: 'integer' },
                          highValueOpportunities: { type: 'integer' }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          404: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'User not found.' },
              code: { type: 'string', example: 'USER_NOT_FOUND' }
            }
          },
          500: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'An error occurred while fetching the resale feed.' },
              code: { type: 'string', example: 'INTERNAL_ERROR' }
            }
          }
        }
      }
    },
    resaleFeedController.getFeed
  );

  // Route for marking an item as sold
  fastify.put(
    '/resale-feed/items/:itemId/sold',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            itemId: { type: 'string' }
          },
          required: ['itemId']
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              message: { type: 'string', example: 'Item marked as sold successfully.' },
              data: {
                type: 'object',
                properties: {
                  item: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      status: { type: 'string' },
                      soldAt: { type: 'string', format: 'date-time' }
                    }
                  }
                }
              }
            }
          },
          404: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'Item not found or you do not have permission to modify it.' },
              code: { type: 'string', example: 'ITEM_NOT_FOUND' }
            }
          },
          500: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'An error occurred while marking the item as sold.' },
              code: { type: 'string', example: 'INTERNAL_ERROR' }
            }
          }
        }
      }
    },
    resaleFeedController.markItemAsSold
  );

  // Route for getting sold items
  fastify.get(
    '/resale-feed/sold-items',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            offset: { type: 'integer', minimum: 0, default: 0 }
          }
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        itemName: { type: 'string' },
                        itemPrice: { type: 'number' },
                        itemQuantity: { type: 'number' },
                        resaleValue: { type: ['number', 'null'] },
                        sellScore: { type: ['number', 'null'] },
                        soldAt: { type: ['string', 'null'], format: 'date-time' },
                        imageUrl: { type: ['string', 'null'] },
                        storeName: { type: ['string', 'null'] },
                        transactionDate: { type: ['string', 'null'], format: 'date-time' },
                        resaleValueHistory: { type: ['array', 'null'] },
                        profitLoss: { type: ['number', 'null'] },
                        profitLossPercentage: { type: ['number', 'null'] },
                        marketData: {
                          type: 'object',
                          properties: {
                            priceAnalysis: {
                              type: 'object',
                              properties: {
                                medianPrice: { type: ['number', 'null'] },
                                meanPrice: { type: ['number', 'null'] },
                                priceRange: {
                                  type: 'object',
                                  properties: {
                                    min: { type: ['number', 'null'] },
                                    max: { type: ['number', 'null'] }
                                  }
                                },
                                volatility: { type: ['number', 'null'] }
                              }
                            },
                            marketTrends: {
                              type: 'object',
                              properties: {
                                direction: { type: 'string' },
                                percentageChange: { type: 'number' },
                                confidence: { type: 'string' },
                                recentAverage: { type: ['number', 'null'] },
                                olderAverage: { type: ['number', 'null'] }
                              }
                            },
                            marketIndicators: {
                              type: 'object',
                              properties: {
                                demandLevel: { type: 'string' },
                                competitionLevel: { type: 'string' },
                                marketActivity: { type: 'string' }
                              }
                            },
                            historicalData: {
                              type: 'array',
                              items: {
                                type: 'object',
                                properties: {
                                  date: { type: 'string' },
                                  value: { type: 'number' },
                                  marketVolume: { type: ['number', 'null'] },
                                  priceVolatility: { type: ['number', 'null'] },
                                  historicalTrend: { type: ['string', 'null'] },
                                  historicalConfidence: { type: ['string', 'null'] },
                                  marketActivity: { type: ['string', 'null'] }
                                }
                              }
                            },
                            timeRange: {
                              type: 'object',
                              properties: {
                                startDate: { type: ['string', 'null'] },
                                endDate: { type: ['string', 'null'] },
                                dataPoints: { type: 'number' }
                              }
                            }
                          }
                        }
                      }
                    }
                  },
                  pagination: {
                    type: 'object',
                    properties: {
                      limit: { type: 'number' },
                      offset: { type: 'number' },
                      total: { type: 'number' },
                      hasMore: { type: 'boolean' }
                    }
                  },
                  summary: {
                    type: 'object',
                    properties: {
                      totalItems: { type: 'number' },
                      totalProfit: { type: 'number' },
                      averageProfitPercentage: { type: 'number' }
                    }
                  }
                }
              }
            }
          },
          500: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'An error occurred while fetching sold items.' },
              code: { type: 'string', example: 'INTERNAL_ERROR' }
            }
          }
        },
      },
    },
    resaleFeedController.getSoldItems
  );

  // Route for getting detailed market data for a single item
  fastify.get(
    '/resale-feed/items/:itemId/market-data',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            itemId: { type: 'string' }
          },
          required: ['itemId']
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  item: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      itemName: { type: 'string' },
                      itemPrice: { type: 'number' },
                      itemQuantity: { type: 'number' },
                      resaleValue: { type: ['number', 'null'] },
                      sellScore: { type: ['number', 'null'] },
                      imageUrl: { type: ['string', 'null'] },
                      storeName: { type: ['string', 'null'] },
                      transactionDate: { type: ['string', 'null'], format: 'date-time' },
                      status: { type: 'string' },
                      recommendedAction: { type: ['string', 'null'] },
                      lastFeedReason: { type: ['string', 'null'] },
                      resaleValueHistory: { type: ['array', 'null'] },
                      profitMargin: { type: ['number', 'null'] },
                      profitLoss: { type: ['number', 'null'] },
                      marketData: {
                        type: 'object',
                        properties: {
                          priceAnalysis: {
                            type: 'object',
                            properties: {
                              medianPrice: { type: ['number', 'null'] },
                              meanPrice: { type: ['number', 'null'] },
                              priceRange: {
                                type: 'object',
                                properties: {
                                  min: { type: ['number', 'null'] },
                                  max: { type: ['number', 'null'] }
                                }
                              },
                              volatility: { type: ['number', 'null'] }
                            }
                          },
                          marketTrends: {
                            type: 'object',
                            properties: {
                              direction: { type: 'string' },
                              percentageChange: { type: 'number' },
                              confidence: { type: 'string' },
                              recentAverage: { type: ['number', 'null'] },
                              olderAverage: { type: ['number', 'null'] }
                            }
                          },
                          marketIndicators: {
                            type: 'object',
                            properties: {
                              demandLevel: { type: 'string' },
                              competitionLevel: { type: 'string' },
                              marketActivity: { type: 'string' }
                            }
                          },
                          historicalData: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                date: { type: 'string' },
                                value: { type: 'number' },
                                marketVolume: { type: ['number', 'null'] },
                                priceVolatility: { type: ['number', 'null'] },
                                historicalTrend: { type: ['string', 'null'] },
                                historicalConfidence: { type: ['string', 'null'] },
                                marketActivity: { type: ['string', 'null'] }
                              }
                            }
                          },
                          timeRange: {
                            type: 'object',
                            properties: {
                              startDate: { type: ['string', 'null'] },
                              endDate: { type: ['string', 'null'] },
                              dataPoints: { type: 'number' }
                            }
                          },
                          freshEbayData: {
                            type: ['object', 'null'],
                            properties: {
                              currentListings: { type: 'number' },
                              historicalData: {
                                type: ['object', 'null'],
                                properties: {
                                  totalSoldItems: { type: 'number' },
                                  totalQuantitySold: { type: 'number' },
                                  trendDirection: { type: 'string' },
                                  trendPercentage: { type: 'number' },
                                  confidence: { type: 'string' },
                                  demandLevel: { type: 'string' },
                                  competitionLevel: { type: 'string' },
                                  marketActivity: { type: 'string' }
                                }
                              },
                              marketTrends: {
                                type: ['object', 'null'],
                                properties: {
                                  totalItems: { type: 'number' },
                                  validItems: { type: 'number' },
                                  trendDirection: { type: 'string' },
                                  trendPercentage: { type: 'number' },
                                  confidence: { type: 'string' }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  },
                  metadata: {
                    type: 'object',
                    properties: {
                      lastUpdated: { type: ['string', 'null'], format: 'date-time' },
                      dataFreshness: { type: 'string' },
                      hasHistoricalData: { type: 'boolean' },
                      hasEbayData: { type: 'boolean' }
                    }
                  }
                }
              }
            }
          },
          404: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'Item not found.' },
              code: { type: 'string', example: 'ITEM_NOT_FOUND' }
            }
          },
          500: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'An error occurred while fetching market data.' },
              code: { type: 'string', example: 'INTERNAL_ERROR' }
            }
          }
        },
      },
    },
    resaleFeedController.getItemMarketData
  );

  // Route for getting user analytics and profile data
  fastify.get(
    '/resale-feed/analytics',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  userProfile: {
                    type: 'object',
                    properties: {
                      level: { type: 'integer' },
                      points: { type: 'integer' },
                      engagementScore: { type: 'number' }
                    }
                  },
                  achievements: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        description: { type: 'string' },
                        points: { type: 'integer' },
                        earnedAt: { type: 'string', format: 'date-time' }
                      }
                    }
                  },
                  sellingStats: {
                    type: 'object',
                    properties: {
                      totalSales: { type: 'integer' },
                      totalProfit: { type: 'number' },
                      averageProfitMargin: { type: 'number' },
                      successRate: { type: 'number' },
                      topCategory: { type: ['string', 'null'] }
                    }
                  },
                  categoryPerformance: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        category: { type: 'string' },
                        salesCount: { type: 'integer' },
                        totalProfit: { type: 'number' },
                        averageMargin: { type: 'number' },
                        preference: { type: 'number' }
                      }
                    }
                  },
                  recommendations: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        type: { type: 'string' },
                        title: { type: 'string' },
                        description: { type: 'string' },
                        priority: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          },
          500: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: { type: 'string', example: 'An error occurred while fetching analytics.' },
              code: { type: 'string', example: 'INTERNAL_ERROR' }
            }
          }
        }
      }
    },
         resaleFeedController.getUserAnalytics
  );
}

module.exports = resaleFeedRoutes;
